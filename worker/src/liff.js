// LINE LIFF 客戶端下單 API：id_token 驗證、匿名團購統計、客戶自助改量／取消。
// 設計原則：
//   - LINE 群組保持完全靜默（本模組不呼叫任何 Reply/Push API）。
//   - 客戶身分一律以 LINE id_token 驗證後的 sub 為準，永不信任前端傳來的 userId。
//   - 訂單語意（去重、建暫存客戶、SET 而非累加、取消刪列、重算總額/狀態、寫變更紀錄）
//     完全對齊 index.js 的 processPostback，讓 LIFF 與商品卡共用同一張訂單。

const CustomerName = require("../../customer-name.js");

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
    const existingCustomer = await env.DB.prepare(`SELECT id, nickname, line_display_name, custom_display_name, address
        FROM customers WHERE line_user_id = ? LIMIT 1`).bind(sub).first();
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

// LINE 原始名稱只寫進 line_display_name；團主自訂名稱（custom_display_name）永不被 LIFF 覆蓋。
function customerUpsertStatement(env, customerId, lineDisplayName, sub) {
    const name = String(lineDisplayName || "").trim();
    return env.DB.prepare(CustomerName.CUSTOMER_UPSERT_SQL).bind(customerId, name || "LINE 客戶", name || null, sub);
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
            gb.status AS group_buy_status, gb.ends_at
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
            p.id AS product_id, p.line_code, p.price, p.pickup_price, p.delivery_price, p.enabled AS product_enabled
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

    const statements = [
        customerUpsertStatement(env, customerId, lineDisplayName, sub),
        // 客戶列 upsert 後、若本次帶入非空地址就更新，維持與訂單同一原子批次。
        ...(willPersistAddress ? [addressUpdateStatement(env, customerId, providedAddress)] : []),
        inboxUpsertStatement(env, orderId, sub, lineDisplayName || customerName, customerId, pickupType),
        env.DB.prepare(`INSERT OR IGNORE INTO orders
            (id, source_message_id, customer_id, pickup_type, status, group_buy_id, line_group_id, total_amount, updated_at)
            VALUES (?, ?, ?, ?, '新訂單', ?, NULL, 0, CURRENT_TIMESTAMP)`)
            .bind(orderId, `liff:${orderId}`, customerId, pickupType, groupBuyId),
        env.DB.prepare(`INSERT INTO order_items
            (order_id, product_code, product_id, quantity, unit_price, amount, item_status, updated_at)
            VALUES (?, ?, ?, ?, ?, ? * ?, 'active', CURRENT_TIMESTAMP)
            ON CONFLICT(order_id, product_id) DO UPDATE SET quantity = excluded.quantity,
            product_code = excluded.product_code, unit_price = excluded.unit_price, amount = excluded.amount,
            item_status = 'active', updated_at = CURRENT_TIMESTAMP`)
            .bind(orderId, productCode, productId, quantity, unitPrice, unitPrice, quantity),
        recomputeStatement(env, orderId, pickupType),
        changeLogStatement(env, orderId, customerId, groupBuyId, productId, "set_quantity", quantityBefore, quantity)
    ];
    await env.DB.batch(statements);

    const order = await buildOrderView(env, customerId, groupBuyId);
    // 回應附掛本人最新地址（與 my-order 一致），供成功畫面顯示；永不進入 stats。
    const finalAddress = willPersistAddress ? providedAddress : normalizeAddress(storedAddress);
    order.address = finalAddress;
    order.hasAddress = hasNonEmptyAddress(finalAddress);
    const stats = await computeStats(env, groupBuyId);
    return json({ ok: true, order, stats });
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
        await env.DB.batch([
            env.DB.prepare("DELETE FROM order_items WHERE order_id = ? AND product_id = ?").bind(existingOrder.id, productId),
            recomputeStatement(env, existingOrder.id),
            changeLogStatement(env, existingOrder.id, customerId, groupBuyId, productId, "cancel_item", quantityBefore, 0)
        ]);
    }
    const order = await buildOrderView(env, customerId, groupBuyId);
    const stats = await computeStats(env, groupBuyId);
    return json({ ok: true, order, stats });
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
        const items = (await env.DB.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").bind(existingOrder.id).all()).results;
        const statements = [];
        for (const item of items) {
            if (item.product_id == null) continue; // 稽核紀錄的 product_id 為 NOT NULL；跳過無 product_id 的舊資料列。
            statements.push(changeLogStatement(env, existingOrder.id, customerId, groupBuyId, item.product_id, "cancel_item", Number(item.quantity || 0), 0));
        }
        statements.push(env.DB.prepare("DELETE FROM order_items WHERE order_id = ?").bind(existingOrder.id));
        statements.push(recomputeStatement(env, existingOrder.id));
        await env.DB.batch(statements);
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
    stableId,
    LiffAuthError,
    LiffHttpError
};
