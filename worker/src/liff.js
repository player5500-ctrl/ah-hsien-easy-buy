// LINE LIFF 客戶端下單 API：id_token 驗證、匿名團購統計、客戶自助改量／取消。
// 設計原則：
//   - LINE 群組保持完全靜默（本模組不呼叫任何 Reply/Push API）。
//   - 客戶身分一律以 LINE id_token 驗證後的 sub 為準，永不信任前端傳來的 userId。
//   - 訂單語意（去重、建暫存客戶、SET 而非累加、取消刪列、重算總額/狀態、寫變更紀錄）
//     完全對齊 index.js 的 processPostback，讓 LIFF 與商品卡共用同一張訂單。

const CustomerName = require("../../customer-name.js");
const Inventory = require("./inventory.js");
const CustomerAccounts = require("./customer-accounts.js");
const ProductGroups = require("./product-groups.js");

const PICKUP_TYPES = new Set(["自取", "外送"]);

class LiffAuthError extends Error {
    constructor(message = "無法驗證您的 LINE 身分") {
        super(message);
        this.name = "LiffAuthError";
    }
}

class LiffHttpError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "LiffHttpError";
        this.status = status;
    }
}

function json(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...headers }
    });
}

// 與 index.js 的 stableId 完全相同的演算法，確保 LIFF 與 Postback 產生同一組客戶/訂單 ID。
async function stableId(prefix, value) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
    return `${prefix}-${[...new Uint8Array(bytes)].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

// 有效價格：自取→pickup_price，外送→delivery_price，缺值時回退 legacy price。
function effectivePrice(product, pickupType) {
    const base = Number(product?.price || 0);
    if (pickupType === "自取") return product?.pickup_price == null ? base : Number(product.pickup_price);
    if (pickupType === "外送") return product?.delivery_price == null ? base : Number(product.delivery_price);
    return base;
}

function groupBuyState(row) {
    if (row.group_buy_status !== "open") return "closed";
    if (Date.now() > new Date(row.ends_at).getTime()) return "expired";
    return "open";
}

// 呼叫 LINE 官方端點驗證 id_token。fetch 走 globalThis.fetch，測試可覆寫 global.fetch；
// 也可直接覆寫 module.exports.verifyLineIdToken 進行 stub（handlers 皆透過 verify() 間接呼叫）。
async function verifyLineIdToken(idToken, env) {
    const token = String(idToken || "").trim();
    const clientId = env && env.LINE_LOGIN_CHANNEL_ID != null ? String(env.LINE_LOGIN_CHANNEL_ID) : "";
    if (!token || !clientId) throw new LiffAuthError();
    let response;
    try {
        response = await globalThis.fetch("https://api.line.me/oauth2/v2.1/verify", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ id_token: token, client_id: clientId }).toString()
        });
    } catch (_error) {
        throw new LiffAuthError();
    }
    if (!response || !response.ok) throw new LiffAuthError();
    let payload;
    try {
        payload = await response.json();
    } catch (_error) {
        throw new LiffAuthError();
    }
    if (!payload || String(payload.aud) !== clientId) throw new LiffAuthError();
    if (!(Number(payload.exp) * 1000 > Date.now())) throw new LiffAuthError();
    if (!payload.sub) throw new LiffAuthError();
    return { sub: String(payload.sub), name: String(payload.name || "") };
}

async function verify(env, idToken) {
    // 透過 module.exports 間接呼叫，讓測試可覆寫 verifyLineIdToken。
    return module.exports.verifyLineIdToken(idToken, env);
}

function extractBearerToken(request) {
    const auth = request.headers.get("authorization") || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : "";
}

async function readJsonBody(request) {
    const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw new LiffHttpError(415, "請以 application/json 格式送出");
    let body;
    try {
        body = await request.json();
    } catch (_error) {
        throw new LiffHttpError(400, "JSON 格式錯誤");
    }
    if (!body || typeof body !== "object") throw new LiffHttpError(400, "JSON 格式錯誤");
    return body;
}

// 空白處理：回傳的 address 為原始字串或 null，hasAddress 以「去空白後非空」為準。
function normalizeAddress(value) {
    if (value == null) return null;
    return String(value);
}
function hasNonEmptyAddress(value) {
    return typeof value === "string" && value.trim() !== "";
}

async function resolveCustomer(env, sub) {
    // 只用 id_token 驗證後的 sub（= LINE userId）查客戶，永不用名稱識別。
    // 多帳號查找（migration-010）：先查 customer_line_accounts、再回退 customers.line_user_id。
    const existingCustomer = await CustomerAccounts.findCustomerByLineUserId(env, sub);
    const customerId = existingCustomer?.id || await stableId("LINE", sub);
    const address = normalizeAddress(existingCustomer?.address);
    return { existingCustomer, customerId, address, hasAddress: hasNonEmptyAddress(address) };
}

// 客戶外送地址是私有資料：只在 UPDATE customers 這一列改，放進與訂單相同的 batch，保持原子性。
function addressUpdateStatement(env, customerId, address) {
    return env.DB.prepare("UPDATE customers SET address = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(address, customerId);
}

// orders.source_message_id 有 FK 指向 line_order_inbox(message_id)，與 processPostback 相同：
// 建立訂單前必須先有對應的收件匣列。以 liff:<orderId> 當 message_id，INSERT OR IGNORE 保持冪等。
function inboxUpsertStatement(env, orderId, sub, customerName, customerId, pickupType) {
    return env.DB.prepare(`INSERT OR IGNORE INTO line_order_inbox
        (message_id, webhook_event_id, group_id, line_user_id, display_name, customer_id, customer_nickname,
         raw_message, normalized_message, parsed_items, action, pickup_type, message_time, status, processed_at, related_order_id)
        VALUES (?, NULL, '', ?, ?, ?, NULL, 'LIFF 自助下單', 'LIFF 自助下單', '[]', 'replace', ?, CURRENT_TIMESTAMP, '已轉正式訂單', CURRENT_TIMESTAMP, ?)`)
        .bind(`liff:${orderId}`, sub, customerName, customerId, pickupType || null, orderId);
}

function recomputeStatement(env, orderId, pickupType) {
    if (pickupType) {
        return env.DB.prepare(`UPDATE orders SET total_amount = COALESCE((SELECT SUM(amount) FROM order_items WHERE order_id = ?), 0),
            status = CASE WHEN EXISTS(SELECT 1 FROM order_items WHERE order_id = ?) THEN '新訂單' ELSE '已取消' END,
            pickup_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(orderId, orderId, pickupType, orderId);
    }
    return env.DB.prepare(`UPDATE orders SET total_amount = COALESCE((SELECT SUM(amount) FROM order_items WHERE order_id = ?), 0),
        status = CASE WHEN EXISTS(SELECT 1 FROM order_items WHERE order_id = ?) THEN '新訂單' ELSE '已取消' END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(orderId, orderId, orderId);
}

function changeLogStatement(env, orderId, customerId, groupBuyId, productId, action, before, after) {
    return env.DB.prepare(`INSERT INTO order_change_logs
        (id, order_id, customer_id, group_buy_id, product_id, action, quantity_before, quantity_after, source_type, webhook_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'liff', NULL)`)
        .bind(crypto.randomUUID(), orderId, customerId, groupBuyId, productId, action, before, after);
}

async function computeStats(env, groupBuyId) {
    // 匿名統計：排除已取消訂單與非 active/數量 0 的品項；不含任何 PII。
    const filter = `FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.group_buy_id = ? AND o.status <> '已取消' AND oi.item_status = 'active' AND oi.quantity > 0`;
    const buyerRow = await env.DB.prepare(`SELECT COUNT(DISTINCT o.customer_id) AS c ${filter}`).bind(groupBuyId).first();
    const qtyRow = await env.DB.prepare(`SELECT COALESCE(SUM(oi.quantity), 0) AS q ${filter}`).bind(groupBuyId).first();
    const perRows = (await env.DB.prepare(`SELECT oi.product_id AS productId, SUM(oi.quantity) AS quantity ${filter}
        GROUP BY oi.product_id`).bind(groupBuyId).all()).results;
    return {
        buyerCount: Number(buyerRow?.c || 0),
        totalQuantity: Number(qtyRow?.q || 0),
        perProduct: perRows.map(row => ({ productId: row.productId, quantity: Number(row.quantity) }))
    };
}

async function buildOrderView(env, customerId, groupBuyId) {
    const order = await env.DB.prepare(`SELECT id, pickup_type AS pickupType, total_amount AS totalAmount, status
        FROM orders WHERE customer_id = ? AND group_buy_id = ? LIMIT 1`).bind(customerId, groupBuyId).first();
    if (!order) return { items: [], pickupType: null, totalAmount: 0, status: null };
    const rows = (await env.DB.prepare(`SELECT oi.product_id AS productId, p.name AS productName, oi.quantity,
            oi.unit_price AS unitPrice, oi.amount
        FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? AND oi.item_status = 'active' AND oi.quantity > 0
        ORDER BY oi.id`).bind(order.id).all()).results;
    const items = rows.map(row => ({
        productId: row.productId,
        productName: row.productName || null,
        quantity: Number(row.quantity),
        unitPrice: Number(row.unitPrice),
        amount: Number(row.amount),
        pickupType: order.pickupType || null
    }));
    return { items, pickupType: order.pickupType || null, totalAmount: Number(order.totalAmount || 0), status: order.status };
}

function getConfig(env) {
    return json({ liffId: env.LIFF_ID || null });
}

async function getGroupBuyProduct(env, groupBuyId, productId) {
    const row = await env.DB.prepare(`SELECT p.id, p.name, p.specs, p.unit, p.image_url, p.price, p.pickup_price, p.delivery_price,
            gb.status AS group_buy_status, gb.ends_at,
            gbp.incoming_quantity, gbp.reserved_quantity, gbp.sellable_quantity,
            gbp.sold_quantity, gbp.remaining_quantity, gbp.low_stock_threshold,
            gbp.stock_status, gbp.stock_enabled
        FROM group_buys gb
        JOIN group_buy_products gbp ON gbp.group_buy_id = gb.id AND gbp.enabled = 1
        JOIN products p ON p.id = gbp.product_id
        WHERE gb.id = ? AND p.id = ? LIMIT 1`).bind(groupBuyId, productId).first();
    if (!row) throw new LiffHttpError(404, "找不到團購商品");
    const stats = await computeStats(env, groupBuyId);
    return json({
        product: {
            id: row.id,
            name: row.name,
            specs: row.specs,
            unit: row.unit,
            image_url: row.image_url,
            price: row.price,
            pickup_price: row.pickup_price,
            delivery_price: row.delivery_price
        },
        groupBuyStatus: groupBuyState(row),
        stock: Inventory.publicStock({ ...row, group_buy_id: groupBuyId, product_id: productId }),
        stats
    });
}

// 「一個商品、多個口味」客戶訂購頁：回傳主商品資料＋全部啟用口味（各自獨立價格／庫存），
// 讓 LIFF 只顯示一張主商品卡，客戶點進去才選口味。已售完的口味仍會列出（前端負責標示不可選）。
async function getGroupBuyProductGroup(env, groupBuyId, productGroupId) {
    const group = await env.DB.prepare("SELECT id, name, description, image_url FROM product_groups WHERE id = ? AND enabled = 1")
        .bind(productGroupId).first();
    if (!group) throw new LiffHttpError(404, "找不到此主商品");
    const groupBuy = await env.DB.prepare("SELECT status AS group_buy_status, ends_at FROM group_buys WHERE id = ? LIMIT 1")
        .bind(groupBuyId).first();
    if (!groupBuy) throw new LiffHttpError(404, "找不到團購");
    const rows = (await env.DB.prepare(`SELECT p.id, p.name, p.variant_name, p.specs, p.unit, p.image_url, p.use_group_image,
            p.price, p.pickup_price, p.delivery_price,
            gbp.incoming_quantity, gbp.reserved_quantity, gbp.sellable_quantity,
            gbp.sold_quantity, gbp.remaining_quantity, gbp.low_stock_threshold,
            gbp.stock_status, gbp.stock_enabled
        FROM products p
        JOIN group_buy_products gbp ON gbp.product_id = p.id AND gbp.group_buy_id = ? AND gbp.enabled = 1
        WHERE p.product_group_id = ? AND p.enabled = 1
        ORDER BY p.variant_sort, p.id`).bind(groupBuyId, productGroupId).all()).results;
    if (!rows.length) throw new LiffHttpError(404, "此主商品目前沒有可訂購的口味");
    const variants = rows.map(row => ({
        productId: row.id,
        variantName: row.variant_name || row.name,
        specs: row.specs,
        unit: row.unit,
        imageUrl: row.use_group_image ? (group.image_url || row.image_url) : row.image_url,
        price: row.price,
        pickupPrice: row.pickup_price,
        deliveryPrice: row.delivery_price,
        stock: Inventory.publicStock({ ...row, group_buy_id: groupBuyId, product_id: row.id })
    }));
    const stats = await computeStats(env, groupBuyId);
    return json({
        productGroup: { id: group.id, name: group.name, description: group.description, imageUrl: group.image_url },
        variants,
        groupBuyStatus: groupBuyState(groupBuy),
        groupStockStatus: ProductGroups.summarizeGroupStock(variants.map(variant => variant.stock)),
        stats
    });
}

async function postSession(request, env) {
    const body = await readJsonBody(request);
    const { sub } = await verify(env, body.idToken);
    const { address, hasAddress } = await resolveCustomer(env, sub);
    // address/hasAddress 只回給經驗證的本人，供 LIFF 頁預填外送地址。
    return json({ ok: true, userId: sub, address, hasAddress });
}

async function getMyOrder(request, env, url) {
    const { sub } = await verify(env, extractBearerToken(request));
    const groupBuyId = String(url.searchParams.get("groupBuyId") || "").trim();
    if (!groupBuyId) throw new LiffHttpError(400, "缺少團購資訊");
    const { customerId, address, hasAddress } = await resolveCustomer(env, sub);
    const order = await buildOrderView(env, customerId, groupBuyId);
    // 地址為本人私有資料：附掛於本人 my-order 回應，永不進入匿名 stats/public。
    order.address = address;
    order.hasAddress = hasAddress;
    return json({ ok: true, order });
}

async function setQuantity(request, env) {
    const body = await readJsonBody(request);
    const { sub, name } = await verify(env, body.idToken);
    const groupBuyId = String(body.groupBuyId || "").trim();
    const productId = String(body.productId || "").trim();
    const pickupType = String(body.pickupType || "").trim();
    const quantity = Number(body.quantity);
    if (!groupBuyId || !productId) throw new LiffHttpError(400, "缺少團購或商品資訊");
    if (!PICKUP_TYPES.has(pickupType)) throw new LiffHttpError(400, "取貨方式錯誤，只接受『自取』或『外送』");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new LiffHttpError(400, "數量需為 1 到 99 的整數");

    const context = await env.DB.prepare(`SELECT gb.status AS group_buy_status, gb.ends_at,
            p.id AS product_id, p.line_code, p.price, p.pickup_price, p.delivery_price, p.enabled AS product_enabled,
            gbp.stock_enabled, gbp.remaining_quantity
        FROM group_buys gb
        JOIN group_buy_products gbp ON gbp.group_buy_id = gb.id AND gbp.enabled = 1
        JOIN products p ON p.id = gbp.product_id
        WHERE gb.id = ? AND p.id = ? LIMIT 1`).bind(groupBuyId, productId).first();
    if (!context) throw new LiffHttpError(404, "找不到團購商品");
    if (context.group_buy_status !== "open" || Date.now() > new Date(context.ends_at).getTime()) throw new LiffHttpError(409, "此團購已截止");
    if (!context.product_enabled) throw new LiffHttpError(409, "商品已停售");

    const { customerId, address: storedAddress, existingCustomer: existingCustomerRow } = await resolveCustomer(env, sub);

    // 選填配送地址：字串、去空白、上限 200 字。providedAddress 為 trim 後的字串（可能為 ""）或 null（未帶）。
    let providedAddress = null;
    if (body.address !== undefined && body.address !== null) {
        if (typeof body.address !== "string") throw new LiffHttpError(400, "配送地址格式錯誤");
        const trimmed = body.address.trim();
        if (trimmed.length > 200) throw new LiffHttpError(400, "配送地址過長，請縮短至 200 字以內");
        providedAddress = trimmed;
    }
    const willPersistAddress = hasNonEmptyAddress(providedAddress);

    // 外送必須有地址：本次帶入的非空地址優先，否則沿用客戶既有地址；兩者皆無 → 409。自取不強制。
    if (pickupType === "外送") {
        const effectiveAddress = willPersistAddress ? providedAddress : String(storedAddress || "").trim();
        if (!effectiveAddress) throw new LiffHttpError(409, "外送地址尚未設定");
    }

    const lineDisplayName = String(name || "").slice(0, 100).trim();
    // 收件匣的 display_name 記 LINE 原始名稱；後台顯示一律走 customers 的解析後名稱。
    const customerName = CustomerName.resolveDisplayName({
        custom_display_name: existingCustomerRow?.custom_display_name,
        line_display_name: lineDisplayName || existingCustomerRow?.line_display_name,
        nickname: existingCustomerRow?.nickname
    }, "LINE 客戶");
    const existingOrder = await env.DB.prepare("SELECT id FROM orders WHERE customer_id = ? AND group_buy_id = ? LIMIT 1")
        .bind(customerId, groupBuyId).first();
    const orderId = existingOrder?.id || await stableId("ORD", `${customerId}:${groupBuyId}`);
    const previousItem = existingOrder
        ? await env.DB.prepare("SELECT quantity FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1").bind(orderId, productId).first()
        : null;
    const quantityBefore = Number(previousItem?.quantity || 0);
    const unitPrice = effectivePrice(context, pickupType);
    const productCode = context.line_code || context.product_id;

    // 建暫存客戶／更新 LINE 原始名稱＋補寫多帳號對照列（LINE 原始名稱只寫 line_display_name，
    // 團主自訂名稱永不被 LIFF 覆蓋；第二個以上帳號不可跑 CUSTOMER_UPSERT_SQL，見 customer-accounts.js）。
    const customerStatements = await CustomerAccounts.customerTouchStatements(env, {
        customerId, existingCustomer: existingCustomerRow, lineUserId: sub, lineDisplayName
    });
    const preStatements = [
        ...customerStatements,
        // 客戶列 upsert 後、若本次帶入非空地址就更新，維持與訂單同一原子批次。
        ...(willPersistAddress ? [addressUpdateStatement(env, customerId, providedAddress)] : []),
        inboxUpsertStatement(env, orderId, sub, lineDisplayName || customerName, customerId, pickupType),
        env.DB.prepare(`INSERT OR IGNORE INTO orders
            (id, source_message_id, customer_id, pickup_type, status, group_buy_id, line_group_id, total_amount, updated_at)
            VALUES (?, ?, ?, ?, '新訂單', ?, NULL, 0, CURRENT_TIMESTAMP)`)
            .bind(orderId, `liff:${orderId}`, customerId, pickupType, groupBuyId),
    ];
    await Inventory.executeOrderMutation(env, {
        orderId,
        groupBuyId,
        customerId,
        changes: [{ productId, productCode, quantity, unitPrice }],
        sourceType: "liff",
        preStatements,
        activeStatus: "新訂單",
        pickupType,
        notes: quantityBefore === 0 ? "LIFF 確認訂購" : "LIFF 修改數量"
    });

    const order = await buildOrderView(env, customerId, groupBuyId);
    // 回應附掛本人最新地址（與 my-order 一致），供成功畫面顯示；永不進入 stats。
    const finalAddress = willPersistAddress ? providedAddress : normalizeAddress(storedAddress);
    order.address = finalAddress;
    order.hasAddress = hasNonEmptyAddress(finalAddress);
    const stats = await computeStats(env, groupBuyId);
    const stock = Inventory.publicStock(await Inventory.getStock(env, groupBuyId, productId));
    return json({ ok: true, order, stats, stock });
}

async function cancelItem(request, env) {
    const body = await readJsonBody(request);
    const { sub } = await verify(env, body.idToken);
    const groupBuyId = String(body.groupBuyId || "").trim();
    const productId = String(body.productId || "").trim();
    if (!groupBuyId || !productId) throw new LiffHttpError(400, "缺少團購或商品資訊");
    const { customerId } = await resolveCustomer(env, sub);
    const existingOrder = await env.DB.prepare("SELECT id FROM orders WHERE customer_id = ? AND group_buy_id = ? LIMIT 1")
        .bind(customerId, groupBuyId).first();
    if (existingOrder) {
        const previousItem = await env.DB.prepare("SELECT quantity FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1")
            .bind(existingOrder.id, productId).first();
        const quantityBefore = Number(previousItem?.quantity || 0);
        if (quantityBefore > 0) {
            await Inventory.executeOrderMutation(env, {
                orderId: existingOrder.id,
                groupBuyId,
                customerId,
                changes: [{ productId, quantity: 0, unitPrice: 0 }],
                sourceType: "liff",
                activeStatus: "新訂單",
                notes: "LIFF 取消商品"
            });
        }
    }
    const order = await buildOrderView(env, customerId, groupBuyId);
    const stats = await computeStats(env, groupBuyId);
    const stock = Inventory.publicStock(await Inventory.getStock(env, groupBuyId, productId));
    return json({ ok: true, order, stats, stock });
}

async function cancelOrder(request, env) {
    const body = await readJsonBody(request);
    const { sub } = await verify(env, body.idToken);
    const groupBuyId = String(body.groupBuyId || "").trim();
    if (!groupBuyId) throw new LiffHttpError(400, "缺少團購資訊");
    const { customerId } = await resolveCustomer(env, sub);
    const existingOrder = await env.DB.prepare("SELECT id FROM orders WHERE customer_id = ? AND group_buy_id = ? LIMIT 1")
        .bind(customerId, groupBuyId).first();
    if (existingOrder) {
        const items = (await env.DB.prepare(`SELECT product_id, product_code, unit_price
            FROM order_items WHERE order_id = ? AND product_id IS NOT NULL`).bind(existingOrder.id).all()).results;
        if (items.length) {
            await Inventory.executeOrderMutation(env, {
                orderId: existingOrder.id,
                groupBuyId,
                customerId,
                changes: items.map(item => ({
                    productId: item.product_id,
                    productCode: item.product_code,
                    quantity: 0,
                    unitPrice: Number(item.unit_price || 0)
                })),
                sourceType: "liff",
                activeStatus: "新訂單",
                notes: "LIFF 取消整張訂單"
            });
        }
    }
    const order = await buildOrderView(env, customerId, groupBuyId);
    const stats = await computeStats(env, groupBuyId);
    return json({ ok: true, order, stats });
}

async function dispatch(request, env, url) {
    const { pathname } = url;
    const method = request.method;

    if (method === "GET" && pathname === "/api/liff/config") return getConfig(env);

    const gbpMatch = pathname.match(/^\/api\/liff\/group-buys\/([^/]+)\/products\/([^/]+)$/);
    if (method === "GET" && gbpMatch) {
        return getGroupBuyProduct(env, decodeURIComponent(gbpMatch[1]), decodeURIComponent(gbpMatch[2]));
    }

    const groupMatch = pathname.match(/^\/api\/liff\/group-buys\/([^/]+)\/product-groups\/([^/]+)$/);
    if (method === "GET" && groupMatch) {
        return getGroupBuyProductGroup(env, decodeURIComponent(groupMatch[1]), decodeURIComponent(groupMatch[2]));
    }

    if (method === "GET" && pathname === "/api/liff/my-order") return getMyOrder(request, env, url);
    if (method === "POST" && pathname === "/api/liff/session") return postSession(request, env);
    if (method === "POST" && pathname === "/api/liff/orders/set-quantity") return setQuantity(request, env);
    if (method === "POST" && pathname === "/api/liff/orders/cancel-item") return cancelItem(request, env);
    if (method === "POST" && pathname === "/api/liff/orders/cancel-order") return cancelOrder(request, env);

    return null;
}

async function handleLiffRoutes(request, env, url) {
    try {
        return await dispatch(request, env, url);
    } catch (error) {
        if (error instanceof LiffAuthError) return json({ error: "無法驗證您的 LINE 身分" }, 401);
        if (error instanceof LiffHttpError) return json({ error: error.message }, error.status);
        if (error instanceof Inventory.InventoryHttpError) {
            return json({
                error: error.code,
                message: error.message,
                remainingQuantity: error.remainingQuantity,
                requestedQuantity: error.requestedQuantity
            }, error.status);
        }
        console.error("LIFF request failed", { message: error?.message || "unknown" });
        return json({ error: "伺服器內部錯誤" }, 500);
    }
}

module.exports = {
    handleLiffRoutes,
    verifyLineIdToken,
    effectivePrice,
    groupBuyState,
    computeStats,
    buildOrderView,
    getGroupBuyProductGroup,
    stableId,
    LiffAuthError,
    LiffHttpError
};
