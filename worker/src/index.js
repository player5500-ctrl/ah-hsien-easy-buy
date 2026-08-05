const LineOrder = require("../../line-order.js");
const { handleWebhook } = require("./webhook-handler.js");
const LineFlex = require("./line-flex.js");
const Liff = require("./liff.js");
const Inventory = require("./inventory.js");
const CustomerName = require("../../customer-name.js");
const CustomerPasteParse = require("../../customer-paste-parse.js");
const CustomerAccounts = require("./customer-accounts.js");
const ProductShared = require("./product-shared.js");
const ProductGroups = require("./product-groups.js");

const ADMIN_ORIGIN = "https://player5500-ctrl.github.io";

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": ADMIN_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
}

function json(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function isAdmin(request, env) {
    const authorization = request.headers.get("authorization") || "";
    return Boolean(env.ADMIN_API_KEY) && authorization === `Bearer ${env.ADMIN_API_KEY}`;
}

function withCors(response) {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function createDependencies(env) {
    return {
        async hasMessage(messageId, webhookEventId) {
            const row = await env.DB.prepare("SELECT 1 FROM line_order_inbox WHERE message_id = ? OR (? <> '' AND webhook_event_id = ?) LIMIT 1")
                .bind(messageId, webhookEventId || "", webhookEventId || "").first();
            return Boolean(row);
        },
        async getDisplayName(conversationType, conversationId, userId) {
            if (!userId || !env.LINE_CHANNEL_ACCESS_TOKEN) return "";
            try {
                const response = await fetch(`https://api.line.me/v2/bot/${conversationType}/${encodeURIComponent(conversationId)}/member/${encodeURIComponent(userId)}`, {
                    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
                });
                return response.ok ? (await response.json()).displayName || "" : "";
            } catch (_error) {
                return "";
            }
        },
        async getProductCodes() {
            const result = await env.DB.prepare("SELECT line_code FROM products WHERE enabled = 1 AND line_code IS NOT NULL").all();
            return result.results.map(row => row.line_code);
        },
        // 客戶識別一律以 line_user_id（event.source.userId）為準；LINE 顯示名稱會變、會重複，不可當識別碼。
        // 僅在「該 LINE 帳號還沒綁定過」時，才用名稱做一次性輔助配對，且必須唯一命中、
        // 且該客戶尚未綁定其他 LINE 帳號，命中後也只用於後台配對建議，不會寫回任何名稱。
        async findCustomer(userId, displayName) {
            // 多帳號查找（migration-010）：先查 customer_line_accounts、再回退 customers.line_user_id。
            const byLineUserId = userId ? await CustomerAccounts.findCustomerByLineUserId(env, userId) : null;
            if (byLineUserId) return { ...byLineUserId, pickupType: byLineUserId.pickup_type, displayName: CustomerName.resolveDisplayName(byLineUserId) };
            const name = String(displayName || "").trim();
            if (!name) return null;
            const candidates = await env.DB.prepare(`SELECT id, nickname, line_display_name, custom_display_name, pickup_type AS pickupType
                FROM customers WHERE line_user_id IS NULL
                AND (TRIM(COALESCE(custom_display_name, '')) = ? OR TRIM(COALESCE(nickname, '')) = ?) LIMIT 2`)
                .bind(name, name).all();
            if (candidates.results.length !== 1) return null;
            const only = candidates.results[0];
            return { ...only, displayName: CustomerName.resolveDisplayName(only) };
        },
        async rememberLineGroup(conversationType, groupId) {
            if (!groupId) return;
            const existing = await env.DB.prepare("SELECT display_name FROM line_groups WHERE group_id = ?").bind(groupId).first();
            let displayName = existing?.display_name || "";
            if (!displayName && conversationType === "group" && env.LINE_CHANNEL_ACCESS_TOKEN) {
                try {
                    const response = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`, {
                        headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
                    });
                    if (response.ok) displayName = (await response.json()).groupName || "";
                } catch (_error) {
                    displayName = "";
                }
            }
            await env.DB.prepare(`INSERT INTO line_groups (group_id, display_name, last_seen_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(group_id) DO UPDATE SET display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE line_groups.display_name END,
                last_seen_at = CURRENT_TIMESTAMP`).bind(groupId, displayName || (conversationType === "room" ? "LINE 聊天室" : "")).run();
        },
        async processPostback(record) {
            return processPostback(env, record);
        },
        async isSuspectedDuplicate(record) {
            const row = await env.DB.prepare("SELECT 1 FROM line_order_inbox WHERE group_id = ? AND line_user_id = ? AND normalized_message = ? AND message_time BETWEEN datetime(?, '-5 minutes') AND datetime(?, '+5 minutes') LIMIT 1")
                .bind(record.groupId, record.lineUserId, record.normalizedMessage, record.messageTime, record.messageTime).first();
            return Boolean(row);
        },
        async insertInbox(record) {
            await env.DB.prepare(`INSERT OR IGNORE INTO line_order_inbox
                (message_id, webhook_event_id, group_id, line_user_id, display_name, customer_id, customer_nickname,
                 raw_message, normalized_message, parsed_items, action, target_product_prefix, pickup_type, message_time, status, error_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(record.messageId, record.webhookEventId || null, record.groupId, record.lineUserId, record.displayName,
                    record.customerId || null, record.customerNickname || null, record.rawMessage, record.normalizedMessage,
                    JSON.stringify(record.parsedItems), record.action, record.targetProductPrefix || null, record.pickupType || null,
                    record.messageTime, record.status, record.errorReason || null).run();
        },
        async markUnsent(messageId, unsentAt) {
            await env.DB.prepare("UPDATE line_order_inbox SET status = ?, error_reason = ?, processed_at = ? WHERE message_id = ? AND status <> ?")
                .bind(LineOrder.STATUS.CANCELLED, "客戶已在 LINE 收回原始訊息", unsentAt, messageId, LineOrder.STATUS.IMPORTED).run();
        }
    };
}

const { normalizeLineCode, validateProductPayload, isUniqueViolation } = ProductShared;

async function readJson(request) {
    try { return await request.json(); } catch (_error) { return null; }
}

const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function handleImageUpload(request, env, url, id) {
    if (!env.IMAGES) return json({ error: "圖片儲存空間未設定（wrangler.toml 需綁定 R2 bucket IMAGES）" }, 503);
    const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_CONTENT_TYPES.has(contentType)) return json({ error: "只接受 JPEG/PNG/WebP/GIF 圖片" }, 415);
    const body = await request.arrayBuffer();
    if (!body.byteLength) return json({ error: "圖片內容是空的" }, 400);
    if (body.byteLength > MAX_IMAGE_BYTES) return json({ error: "圖片不可超過 5MB" }, 413);
    const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?").bind(id).first();
    if (!product) return json({ error: "找不到商品" }, 404);
    const key = `products/${id}`;
    await env.IMAGES.put(key, body, { httpMetadata: { contentType } });
    const imageUrl = `${url.origin}/images/${key}?v=${Date.now()}`;
    await env.DB.prepare("UPDATE products SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(imageUrl, id).run();
    return json({ id, image_url: imageUrl });
}

async function serveImage(env, url) {
    if (!env.IMAGES) return new Response("Not found", { status: 404 });
    const key = decodeURIComponent(url.pathname.slice("/images/".length));
    const object = await env.IMAGES.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
        headers: {
            "content-type": object.httpMetadata?.contentType || "application/octet-stream",
            "cache-control": "public, max-age=86400"
        }
    });
}

async function handleProductRoutes(request, env, url) {
    if (request.method === "GET" && url.pathname === "/api/products") {
        const rows = await env.DB.prepare("SELECT * FROM products ORDER BY enabled DESC, line_code").all();
        return json(rows.results);
    }
    if (request.method === "POST" && url.pathname === "/api/products") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const product = validateProductPayload(payload);
        if (product.error) return json({ error: product.error }, 400);
        const id = crypto.randomUUID();
        try {
            await env.DB.prepare("INSERT INTO products (id, name, enabled, line_code, price, pickup_price, delivery_price, specs, unit, description, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)")
                .bind(id, product.name, product.enabled, product.lineCode, product.price, product.pickupPrice, product.deliveryPrice, product.specs, product.unit, product.description, product.imageUrl).run();
        } catch (error) {
            if (isUniqueViolation(error)) return json({ error: `商品代碼 ${product.lineCode} 已存在` }, 409);
            throw error;
        }
        return json({ id, created: true }, 201);
    }
    const imageMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/image$/);
    if (imageMatch && request.method === "POST") return handleImageUpload(request, env, url, decodeURIComponent(imageMatch[1]));
    const idMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (!idMatch) return null;
    const id = decodeURIComponent(idMatch[1]);
    if (request.method === "PUT") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const product = validateProductPayload(payload);
        if (product.error) return json({ error: product.error }, 400);
        let result;
        try {
            result = await env.DB.prepare("UPDATE products SET name = ?, enabled = ?, line_code = ?, price = ?, pickup_price = ?, delivery_price = ?, specs = ?, unit = ?, description = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(product.name, product.enabled, product.lineCode, product.price, product.pickupPrice, product.deliveryPrice, product.specs, product.unit, product.description, product.imageUrl, id).run();
        } catch (error) {
            if (isUniqueViolation(error)) return json({ error: `商品代碼 ${product.lineCode} 已存在` }, 409);
            throw error;
        }
        if (!result.meta.changes) {
            try {
                await env.DB.prepare("INSERT INTO products (id, name, enabled, line_code, price, pickup_price, delivery_price, specs, unit, description, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)")
                    .bind(id, product.name, product.enabled, product.lineCode, product.price, product.pickupPrice, product.deliveryPrice, product.specs, product.unit, product.description, product.imageUrl).run();
            } catch (error) {
                if (isUniqueViolation(error)) return json({ error: `商品代碼 ${product.lineCode} 已存在` }, 409);
                throw error;
            }
            return json({ id, created: true }, 201);
        }
        return json({ id, updated: true });
    }
    if (request.method === "DELETE") {
        // 有訂單紀錄的商品不可刪除（與前端規則一致，保護訂單參照與稽核）；
        // 可刪除時先清 group_buy_products 參照，避免外鍵造成 500（2026-07-23 修正）。
        const ordered = await env.DB.prepare("SELECT 1 FROM order_items WHERE product_id = ? OR product_code = ? LIMIT 1").bind(id, id).first();
        if (ordered) return json({ error: "此商品已有訂單紀錄，不可刪除，請改用停用" }, 409);
        const results = await env.DB.batch([
            env.DB.prepare("DELETE FROM group_buy_products WHERE product_id = ?").bind(id),
            env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id)
        ]);
        if (!results[1].meta.changes) return json({ error: "找不到商品" }, 404);
        return json({ id, deleted: true });
    }
    return null;
}

// 「一個商品、多個口味／款式」：主商品（product_groups）＋口味（products，各自獨立價格／庫存／訂單）。
// 商品編號一律伺服器產生，不接受前端指定；細節見 product-groups.js 開頭註解。
async function handleProductGroupRoutes(request, env, url) {
    if (request.method === "GET" && url.pathname === "/api/product-groups") {
        return json(await ProductGroups.listProductGroups(env));
    }
    if (request.method === "POST" && url.pathname === "/api/product-groups") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const result = await ProductGroups.createProductGroupWithVariants(env, payload);
        return result.error ? json({ error: result.error }, result.status) : json(result.data, result.data?.created ? 201 : 200);
    }
    if (request.method === "POST" && url.pathname === "/api/product-groups/merge-existing/preview") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const result = await ProductGroups.previewMerge(env, payload);
        return result.error ? json({ error: result.error }, result.status) : json(result.data);
    }
    if (request.method === "POST" && url.pathname === "/api/product-groups/merge-existing") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const result = await ProductGroups.applyMerge(env, payload);
        return result.error ? json({ error: result.error }, result.status) : json(result.data);
    }
    const variantMatch = url.pathname.match(/^\/api\/product-groups\/([^/]+)\/variants\/([^/]+)$/);
    if (variantMatch && request.method === "PUT") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const result = await ProductGroups.updateVariant(env, decodeURIComponent(variantMatch[1]), decodeURIComponent(variantMatch[2]), payload);
        return result.error ? json({ error: result.error }, result.status) : json(result.data);
    }
    const addVariantMatch = url.pathname.match(/^\/api\/product-groups\/([^/]+)\/variants$/);
    if (addVariantMatch && request.method === "POST") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const result = await ProductGroups.addVariantToGroup(env, decodeURIComponent(addVariantMatch[1]), payload);
        return result.error ? json({ error: result.error }, result.status) : json(result.data, result.data?.created ? 201 : 200);
    }
    const idMatch = url.pathname.match(/^\/api\/product-groups\/([^/]+)$/);
    if (!idMatch) return null;
    const groupId = decodeURIComponent(idMatch[1]);
    if (request.method === "GET") {
        const group = await ProductGroups.getProductGroup(env, groupId);
        return group ? json(group) : json({ error: "找不到主商品" }, 404);
    }
    if (request.method === "PUT") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const result = await ProductGroups.updateProductGroup(env, groupId, payload);
        return result.error ? json({ error: result.error }, result.status) : json(result.data);
    }
    if (request.method === "DELETE") {
        const result = await ProductGroups.deleteProductGroup(env, groupId);
        return result.error ? json({ error: result.error }, result.status) : json(result.data);
    }
    return null;
}

// ==========================================================================
// 客戶管理 API（後台）
// 團主在「客戶管理」修改的名稱必須存到雲端，否則只留在瀏覽器 localStorage，
// 下次同步就會被 D1 的 LINE 原始名稱蓋回去（這是「訂單仍顯示蜜茶」的直接原因之一）。
// 這裡只寫 custom_display_name / pickup_type / address / notes，
// 永不寫 line_user_id 與 line_display_name（識別碼與 LINE 原始名稱由 Webhook 維護）。
// notes（備註／本名）同理：只存在 localStorage 的話換裝置就消失，所以 migration-008 之後一律存雲端。
// ==========================================================================
// withAccounts = customer_line_accounts 對照表已存在（migration-010）：多回一欄 line_accounts_count（綁定帳號數）。
// 既有欄位一律原樣保留；前端拿不到這欄（Worker 尚未升級或表未建）時視為舊行為，向後相容。
function customerSelectSql(withAccounts) {
    const accountsColumn = withAccounts
        ? "(SELECT COUNT(*) FROM customer_line_accounts a WHERE a.customer_id = customers.id) AS line_accounts_count, "
        : "";
    return `SELECT id, nickname, line_display_name, custom_display_name, line_user_id, pickup_type, address, notes,
        profile_status, created_at, updated_at, ${accountsColumn}${CustomerName.resolvedNameSql()} AS customer_display_name
        FROM customers`;
}

function validateCustomerPayload(payload) {
    if (!payload || typeof payload !== "object") return { error: "JSON 格式錯誤" };
    // 團主自訂名稱可留空：帶了但是空字串＝「取消自訂」，顯示時回退 LINE 原始名稱；
    // 完全沒帶這個欄位＝「這次不動名稱」（部分更新），兩者語意必須分開，
    // 否則只更新取貨方式的請求會把名稱清掉。
    const nameProvided = payload.custom_display_name !== undefined || payload.nickname !== undefined;
    const rawName = payload.custom_display_name !== undefined ? payload.custom_display_name : payload.nickname;
    const customName = rawName === null || rawName === undefined ? "" : String(rawName).trim();
    if (customName.length > 100) return { error: "客戶名稱請縮短至 100 字以內" };
    const pickupType = String(payload.pickup_type || "").trim();
    if (pickupType && !new Set(["自取", "外送"]).has(pickupType)) return { error: "取貨方式只接受『自取』或『外送』" };
    // 地址空字串視為「未提供」而不是「清空」：地址是客人在 LIFF 自己填的資料，
    // 團主在客戶管理存檔時不可把它清掉（COALESCE('', x) 會等於 ''，所以一定要轉 null）。
    const rawAddress = payload.address === undefined || payload.address === null ? "" : String(payload.address).trim().slice(0, 200);
    // 備註（多半是客人本名）是團主自己的筆記，所以「帶空字串」＝真的要清空，「完全沒帶」＝這次不動備註。
    // 與名稱同一套語意，否則只更新取貨方式的請求會把備註清掉。過長一律截斷（不擋存檔）。
    const notesProvided = payload.notes !== undefined;
    const rawNotes = payload.notes === undefined || payload.notes === null ? "" : String(payload.notes).trim().slice(0, 500);
    return {
        customName: customName || null, nameProvided, pickupType: pickupType || null, address: rawAddress || null,
        notes: rawNotes || null, notesProvided
    };
}

// ==========================================================================
// 客戶「快速貼上匯入」批次匯入（POST /api/customers/bulk-import）
//
// 欄位對應照 Vanny 手動建檔的既有慣例（不是把貼上的編號當 id）：
//   id                   = 系統自動配號 A001／A002…（接續現有最大 A### 往下發）
//   custom_display_name  = `<編號>-<LINE暱稱>`，例：005-小葉娃
//   line_display_name    = LINE 暱稱（LINE 訊息比對靠這欄）
//   nickname             = 本名（NOT NULL，向後相容）
//   notes                = 本名（備註欄，migration-008 之後存雲端，換裝置才看得到）
//   phone                = 前端 localStorage 才有的欄位，D1 customers 沒有這一欄
//
// 只寫名稱三欄＋備註（custom_display_name / line_display_name / nickname / notes）：
// line_user_id、pickup_type、address、profile_status 一律不動，
// 否則 LINE 綁定會斷、客人在 LIFF 填的地址會被清掉、訂單也會找不到客戶。
// ⚠️ 貼上的編號一律是字串（"001" 不是 1），不可用 Number() 處理。
// ⚠️ 配號一律在伺服器端算（前端算的只用來預覽），否則兩個分頁同時匯入會撞 PRIMARY KEY。
// ==========================================================================
const BULK_IMPORT_MAX_ITEMS = 500;
// 配號與「已存在」判斷都要看全表：配號要抓最大 A###（字典序不可靠，得在 JS 比數字），
// 已存在要比對 custom_display_name 的 `<編號>-` 前綴（無法用 id IN (...) 查）。
const BULK_IMPORT_SCAN_LIMIT = 10000;

function validateBulkImportItem(item) {
    if (!item || typeof item !== "object") return { error: "資料格式錯誤" };
    const code = item.code === null || item.code === undefined ? "" : String(item.code).trim();
    const name = item.name === null || item.name === undefined ? "" : String(item.name).trim();
    const lineName = item.lineName === null || item.lineName === undefined ? "" : String(item.lineName).trim();
    const mode = String(item.mode || "skip").trim() === "update" ? "update" : "skip";
    const existingId = item.existingId === null || item.existingId === undefined ? "" : String(item.existingId).trim();
    if (!code) return { error: "缺少客戶編號" };
    if (code.length > 16) return { error: "客戶編號請縮短至 16 字以內" };
    if (!/^\d+$/.test(code)) return { error: "客戶編號只接受數字" };
    if (!name) return { error: "缺少客戶姓名" };
    if (name.length > 100) return { error: "客戶姓名請縮短至 100 字以內" };
    if (lineName.length > 100) return { error: "LINE 名稱請縮短至 100 字以內" };
    if (existingId.length > 64) return { error: "客戶識別碼格式錯誤" };
    // LINE 名稱留空時沿用姓名（與前端解析規則一致）。
    return { code, name, lineName: lineName || name, mode, existingId };
}

// 一次撈回名冊快照：配號要用全部 id，已存在判斷要用 custom_display_name。
async function loadCustomerIndex(env) {
    const rows = await env.DB.prepare(`SELECT id, nickname, custom_display_name, line_display_name
        FROM customers LIMIT ${BULK_IMPORT_SCAN_LIMIT}`).all();
    return Array.isArray(rows.results) ? rows.results : [];
}

// 「已存在」＝有客戶的 custom_display_name 以 `<編號>-` 開頭（例：005-小葉娃 對上編號 005）。
// 編號不是 id，所以不能用 id 比對；找不到前綴時再退回比 existingId（前端預覽算出來的）。
function findCustomerByCode(customers, code, existingId) {
    for (const row of customers) {
        if (CustomerPasteParse.matchesCustomerCode(row.custom_display_name, code)) return row;
    }
    if (existingId) {
        for (const row of customers) {
            if (String(row.id) === existingId) return row;
        }
    }
    return null;
}

// 略過既有客戶時，回報「現有資料 vs 貼上資料」的差異，讓團主知道自己略過了什麼。
function describeSkipDifference(existing, item) {
    const currentName = String(existing.custom_display_name || existing.nickname || "").trim();
    const currentLineName = String(existing.line_display_name || "").trim();
    const nextName = CustomerPasteParse.buildCustomDisplayName(item.code, item.lineName);
    const diff = [];
    if (currentName !== nextName) diff.push(`名稱「${currentName || "（空白）"}」→「${nextName}」`);
    if (currentLineName !== item.lineName) diff.push(`LINE 名稱「${currentLineName || "（空白）"}」→「${item.lineName}」`);
    return diff.length
        ? `客戶編號已存在（${existing.id}），已略過（差異：${diff.join("；")}）`
        : `客戶編號已存在（${existing.id}），資料相同，已略過`;
}

async function handleCustomerBulkImport(request, env) {
    const payload = await readJson(request);
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) return json({ error: "JSON 格式錯誤" }, 400);
    if (!payload.items.length) return json({ error: "沒有可匯入的資料" }, 400);
    if (payload.items.length > BULK_IMPORT_MAX_ITEMS) return json({ error: `一次最多匯入 ${BULK_IMPORT_MAX_ITEMS} 筆，請分批貼上` }, 400);

    // 第一輪：逐筆驗證，並在同一批資料內去重（同一個編號只處理第一筆，
    // 否則同一批會配出兩個號、寫成兩位重複客戶）。
    const plans = [];
    const seen = new Set();
    for (const raw of payload.items) {
        const item = validateBulkImportItem(raw);
        if (item.error) {
            const shownCode = raw && typeof raw === "object" && raw.code !== undefined && raw.code !== null ? String(raw.code).trim().slice(0, 16) : "";
            plans.push({ ok: false, code: shownCode, id: "", action: "failed", note: item.error });
            continue;
        }
        if (seen.has(item.code)) {
            plans.push({ ok: false, code: item.code, id: "", action: "skipped", note: "同一批資料中重複的客戶編號，只處理第一筆" });
            continue;
        }
        seen.add(item.code);
        plans.push({ ok: true, item });
    }

    const customers = await loadCustomerIndex(env);
    // 配號一律以資料庫現況為準（前端傳來的預覽號碼完全忽略），同一批連號往下發。
    const allocateCustomerId = CustomerPasteParse.createCustomerIdAllocator(customers.map(row => row.id));
    const statements = [];
    const details = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const plan of plans) {
        if (!plan.ok) {
            if (plan.action === "failed") failed += 1; else skipped += 1;
            details.push({ code: plan.code, id: plan.id, action: plan.action, note: plan.note });
            continue;
        }
        const item = plan.item;
        const displayName = CustomerPasteParse.buildCustomDisplayName(item.code, item.lineName);
        const current = findCustomerByCode(customers, item.code, item.existingId);
        if (current) {
            if (item.mode !== "update") {
                skipped += 1;
                details.push({ code: item.code, id: String(current.id), action: "skipped", note: describeSkipDifference(current, item) });
                continue;
            }
            // 只更新名稱三欄＋備註（本名）；line_user_id／pickup_type／address／profile_status 完全不碰。
            statements.push(env.DB.prepare(`UPDATE customers
                SET custom_display_name = ?, line_display_name = ?, nickname = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`).bind(displayName, item.lineName, item.name, item.name, current.id));
            updated += 1;
            details.push({ code: item.code, id: String(current.id), action: "updated", note: `已更新 ${current.id} 的名稱與 LINE 名稱` });
            continue;
        }
        const newId = allocateCustomerId();
        statements.push(env.DB.prepare(`INSERT INTO customers
            (id, nickname, custom_display_name, line_display_name, line_user_id, pickup_type, address, notes, profile_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
            .bind(newId, item.name, displayName, item.lineName, item.name));
        // 同一批後面的資料也要看得到剛配出去的號與名稱，否則貼兩次同編號會各配一個號。
        customers.push({ id: newId, nickname: item.name, custom_display_name: displayName, line_display_name: item.lineName, notes: item.name });
        created += 1;
        details.push({ code: item.code, id: newId, action: "created", note: `已新增客戶（配號 ${newId}）` });
    }

    if (statements.length) {
        try {
            await env.DB.batch(statements);
        } catch (error) {
            console.error("Customer bulk import failed", error);
            return json({ error: "匯入寫入失敗，請確認資料後再試一次" }, 500);
        }
    }
    return json({ ok: true, created, updated, skipped, failed, details });
}

async function handleCustomerRoutes(request, env, url) {
    const withAccounts = await CustomerAccounts.lineAccountsTableAvailable(env);
    if (request.method === "GET" && url.pathname === "/api/customers") {
        const rows = await env.DB.prepare(`${customerSelectSql(withAccounts)} ORDER BY id LIMIT 2000`).all();
        return json(rows.results);
    }
    // 必須排在 /api/customers/:id 之前，否則 "bulk-import" 會被當成客戶編號。
    if (request.method === "POST" && url.pathname === "/api/customers/bulk-import") {
        return handleCustomerBulkImport(request, env);
    }
    const idMatch = url.pathname.match(/^\/api\/customers\/([^/]+)$/);
    if (!idMatch) return null;
    const id = decodeURIComponent(idMatch[1]).trim();
    if (!id) return json({ error: "缺少客戶編號" }, 400);

    if (request.method === "GET") {
        const row = await env.DB.prepare(`${customerSelectSql(withAccounts)} WHERE id = ? LIMIT 1`).bind(id).first();
        return row ? json(row) : json({ error: "找不到客戶" }, 404);
    }

    if (request.method === "PUT") {
        const payload = await readJson(request);
        const customer = validateCustomerPayload(payload);
        if (customer.error) return json({ error: customer.error }, 400);
        const nameFlag = customer.nameProvided ? 1 : 0;
        const notesFlag = customer.notesProvided ? 1 : 0;
        await env.DB.prepare(`INSERT INTO customers
            (id, nickname, custom_display_name, line_display_name, line_user_id, pickup_type, address, notes, profile_status, created_at, updated_at)
            VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                custom_display_name = CASE WHEN ? = 1 THEN excluded.custom_display_name ELSE customers.custom_display_name END,
                nickname = COALESCE(
                    NULLIF(TRIM(COALESCE(CASE WHEN ? = 1 THEN excluded.custom_display_name ELSE customers.custom_display_name END, '')), ''),
                    NULLIF(TRIM(COALESCE(customers.line_display_name, '')), ''),
                    NULLIF(TRIM(COALESCE(customers.nickname, '')), ''),
                    excluded.nickname),
                pickup_type = COALESCE(excluded.pickup_type, customers.pickup_type),
                address = COALESCE(excluded.address, customers.address),
                -- 備註有帶就照帶的值寫（空字串＝清空）；沒帶就完全不動，避免部分更新把備註洗掉。
                notes = CASE WHEN ? = 1 THEN excluded.notes ELSE customers.notes END,
                -- LINE 自動建立的暫存客戶（LINE-xxxx + pending）要保留 pending，
                -- 否則之後在收件匣「綁定客戶」會被判成重複綁定而永久卡在 409。
                profile_status = CASE WHEN customers.profile_status = 'pending' AND customers.id LIKE 'LINE-%'
                    THEN customers.profile_status ELSE 'complete' END,
                updated_at = CURRENT_TIMESTAMP`)
            .bind(id, customer.customName || id, customer.customName, customer.pickupType, customer.address, customer.notes,
                nameFlag, nameFlag, notesFlag).run();
        const row = await env.DB.prepare(`${customerSelectSql(withAccounts)} WHERE id = ? LIMIT 1`).bind(id).first();
        return json({ id, updated: true, customer: row });
    }

    if (request.method === "DELETE") {
        // 有訂單紀錄的客戶不可刪除（與前端規則一致，保護訂單參照與稽核）。
        const ordered = await env.DB.prepare("SELECT 1 FROM orders WHERE customer_id = ? LIMIT 1").bind(id).first();
        if (ordered) return json({ error: "此客戶已有訂單紀錄，不可刪除" }, 409);
        // 先清 customer_line_accounts 對照列（FK 指向 customers），否則刪客戶會撞外鍵變 500。
        const result = withAccounts
            ? (await env.DB.batch([
                env.DB.prepare("DELETE FROM customer_line_accounts WHERE customer_id = ?").bind(id),
                env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id)
            ]))[1]
            : await env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
        if (!result.meta.changes) return json({ error: "找不到客戶" }, 404);
        return json({ id, deleted: true });
    }
    return null;
}

function isoFromTimestamp(timestamp) {
    const value = new Date(Number(timestamp) || Date.now());
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
}

async function stableId(prefix, value) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
    return `${prefix}-${[...new Uint8Array(bytes)].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function reserveWebhookEvent(env, record) {
    if (!record.webhookEventId) return { reserved: false, error: "缺少 webhookEventId" };
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO line_webhook_events
        (id, webhook_event_id, event_type, line_user_id, group_id, process_status, received_at)
        VALUES (?, ?, 'postback', ?, ?, 'processing', ?)`)
        .bind(crypto.randomUUID(), record.webhookEventId, record.lineUserId || null, record.groupId || null, isoFromTimestamp(record.timestamp)).run();
    if (result.meta?.changes) return { reserved: true };
    const retry = await env.DB.prepare(`UPDATE line_webhook_events SET process_status = 'processing', error_message = NULL,
        received_at = ?, processed_at = NULL WHERE webhook_event_id = ? AND process_status = 'failed'`)
        .bind(isoFromTimestamp(record.timestamp), record.webhookEventId).run();
    return { reserved: Boolean(retry.meta?.changes) };
}

async function markWebhookFailed(env, webhookEventId, message) {
    if (!webhookEventId) return;
    await env.DB.prepare("UPDATE line_webhook_events SET process_status = 'failed', error_message = ?, processed_at = CURRENT_TIMESTAMP WHERE webhook_event_id = ?")
        .bind(String(message || "處理失敗").slice(0, 500), webhookEventId).run();
}

async function processPostback(env, record) {
    const reservation = await reserveWebhookEvent(env, record);
    if (!reservation.reserved) return { duplicate: !reservation.error, error: reservation.error };
    try {
        const parsed = LineFlex.parsePostbackData(record.data);
        if (parsed.error) {
            await markWebhookFailed(env, record.webhookEventId, parsed.error);
            return { processed: false, error: parsed.error };
        }
        if (!record.lineUserId || !record.groupId) {
            await markWebhookFailed(env, record.webhookEventId, "Postback 缺少 LINE 使用者或群組識別碼");
            return { processed: false, error: "缺少 LINE 來源資料" };
        }
        const context = await env.DB.prepare(`SELECT gb.id AS group_buy_id, gb.ends_at, gb.status AS group_buy_status,
            p.id AS product_id, p.line_code, p.price, p.enabled AS product_enabled
            FROM group_buys gb
            JOIN group_buy_products gbp ON gbp.group_buy_id = gb.id AND gbp.enabled = 1
            JOIN products p ON p.id = gbp.product_id
            WHERE gb.id = ? AND p.id = ? LIMIT 1`).bind(parsed.groupBuyId, parsed.productId).first();
        if (!context) {
            await markWebhookFailed(env, record.webhookEventId, "團購不存在或商品不屬於該團購");
            return { processed: false, error: "團購或商品無效" };
        }
        if (context.group_buy_status !== "open" || Date.now() > new Date(context.ends_at).getTime()) {
            await markWebhookFailed(env, record.webhookEventId, "團購已截止");
            return { processed: false, error: "團購已截止" };
        }
        if (!context.product_enabled) {
            await markWebhookFailed(env, record.webhookEventId, "商品已停售");
            return { processed: false, error: "商品已停售" };
        }

        // 多帳號查找（migration-010）：先查 customer_line_accounts、再回退 customers.line_user_id。
        const existingCustomer = await CustomerAccounts.findCustomerByLineUserId(env, record.lineUserId);
        const customerId = existingCustomer?.id || await stableId("LINE", record.lineUserId);
        // LINE 原始名稱只寫進 line_display_name；訂單顯示改用解析後名稱（團主自訂優先）。
        const lineDisplayName = String(record.displayName || "").slice(0, 100).trim();
        const customerName = CustomerName.resolveDisplayName({
            custom_display_name: existingCustomer?.custom_display_name,
            line_display_name: lineDisplayName || existingCustomer?.line_display_name,
            nickname: existingCustomer?.nickname
        }, "LINE 客戶");
        const existingOrder = await env.DB.prepare("SELECT id FROM orders WHERE customer_id = ? AND group_buy_id = ? LIMIT 1")
            .bind(customerId, parsed.groupBuyId).first();
        const orderId = existingOrder?.id || await stableId("ORD", `${customerId}:${parsed.groupBuyId}`);
        const previousItem = existingOrder ? await env.DB.prepare("SELECT quantity FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1")
            .bind(orderId, parsed.productId).first() : null;
        const quantityBefore = Number(previousItem?.quantity || 0);

        // 建暫存客戶／更新 LINE 原始名稱＋補寫多帳號對照列。
        // 第二個以上帳號解析出的客戶不可跑 CUSTOMER_UPSERT_SQL（會撞 customers.id 主鍵），詳見 customer-accounts.js。
        const customerStatements = await CustomerAccounts.customerTouchStatements(env, {
            customerId, existingCustomer, lineUserId: record.lineUserId, lineDisplayName
        });

        if (parsed.action === "view_order") {
            await env.DB.batch([
                ...customerStatements,
                env.DB.prepare("UPDATE line_webhook_events SET process_status = 'processed', error_message = NULL, processed_at = CURRENT_TIMESTAMP WHERE webhook_event_id = ?")
                    .bind(record.webhookEventId)
            ]);
            return { processed: true, action: parsed.action };
        }

        // 收件匣以「人看得懂」的文字記錄商品卡操作，並帶上已配對的客戶（2026-07-23 體驗修正）
        const productLabel = context.line_code || context.product_id;
        const friendlyMessage = parsed.action === "set_quantity"
            ? `商品卡：${productLabel} 設為 ${parsed.quantity} 份`
            : `商品卡：取消 ${productLabel}`;
        const inboxCustomerId = existingCustomer?.id || null;
        const inboxInsert = env.DB.prepare(`INSERT OR IGNORE INTO line_order_inbox
            (message_id, webhook_event_id, group_id, line_user_id, display_name, customer_id, customer_nickname,
            raw_message, normalized_message, parsed_items, action, message_time, status, processed_at, related_order_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, CURRENT_TIMESTAMP, ?)`)
            .bind(`postback:${record.webhookEventId}`, record.webhookEventId, record.groupId, record.lineUserId,
                lineDisplayName, inboxCustomerId, existingCustomer ? customerName : null,
                friendlyMessage, record.data, parsed.action === "set_quantity" ? "replace" : "cancel",
                isoFromTimestamp(record.timestamp), LineOrder.STATUS.IMPORTED, orderId);

        const preStatements = [...customerStatements, inboxInsert];
        if (parsed.action === "set_quantity") {
            preStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO orders
                (id, source_message_id, customer_id, pickup_type, status, group_buy_id, line_group_id, total_amount, updated_at)
                VALUES (?, ?, ?, '', '新訂單', ?, ?, 0, CURRENT_TIMESTAMP)`)
                .bind(orderId, `postback:${record.webhookEventId}`, customerId, parsed.groupBuyId, record.groupId));
        }
        await Inventory.executeOrderMutation(env, {
            orderId,
            groupBuyId: parsed.groupBuyId,
            customerId,
            changes: [{
                productId: context.product_id,
                productCode: context.line_code || context.product_id,
                quantity: parsed.action === "set_quantity" ? parsed.quantity : 0,
                unitPrice: Number(context.price || 0)
            }],
            sourceType: "line_postback",
            webhookEventId: record.webhookEventId,
            preStatements,
            activeStatus: "新訂單",
            notes: parsed.action === "set_quantity" ? "LINE 商品卡確認訂購" : "LINE 商品卡取消商品",
            postStatements: [
                env.DB.prepare("UPDATE orders SET line_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(record.groupId, orderId),
                env.DB.prepare("UPDATE line_webhook_events SET process_status = 'processed', error_message = NULL, processed_at = CURRENT_TIMESTAMP WHERE webhook_event_id = ?")
                    .bind(record.webhookEventId)
            ]
        });
        return { processed: true, action: parsed.action, orderId, quantity: parsed.quantity || 0 };
    } catch (error) {
        await markWebhookFailed(env, record.webhookEventId, error?.message || "Postback 處理失敗");
        if (error instanceof Inventory.InventoryHttpError) {
            return { processed: false, error: error.message, code: error.code, remainingQuantity: error.remainingQuantity };
        }
        console.error("LINE postback processing failed", { webhookEventId: record.webhookEventId, message: error?.message || "unknown" });
        return { processed: false, error: "Postback 處理失敗" };
    }
}

function validateGroupBuyPayload(payload) {
    const id = String(payload?.id || "").trim();
    const name = String(payload?.name || "").trim();
    const endsAt = new Date(payload?.ends_at || "");
    const startsAt = payload?.starts_at ? new Date(payload.starts_at) : null;
    const status = String(payload?.status || "open");
    if (!id || !name) return { error: "團購 ID 與名稱必填" };
    if (Number.isNaN(endsAt.getTime())) return { error: "收單截止時間格式錯誤" };
    if (startsAt && Number.isNaN(startsAt.getTime())) return { error: "團購開始時間格式錯誤" };
    if (!new Set(["open", "closed", "completed"]).has(status)) return { error: "團購狀態錯誤" };
    return {
        id, name, endsAt: endsAt.toISOString(), status,
        startsAt: startsAt?.toISOString() || null,
        notes: String(payload?.notes || "").trim() || null,
        productIds: [...new Set((Array.isArray(payload?.product_ids) ? payload.product_ids : []).map(value => String(value).trim()).filter(Boolean))]
    };
}

async function upsertGroupBuy(env, payload) {
    const groupBuy = validateGroupBuyPayload(payload);
    if (groupBuy.error) return { error: groupBuy.error, status: 400 };
    const statements = [env.DB.prepare(`INSERT INTO group_buys (id, name, starts_at, ends_at, status, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        status = excluded.status, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
        .bind(groupBuy.id, groupBuy.name, groupBuy.startsAt, groupBuy.endsAt, groupBuy.status, groupBuy.notes),
    env.DB.prepare("UPDATE group_buy_products SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE group_buy_id = ?")
        .bind(groupBuy.id)];
    for (const productId of groupBuy.productIds) {
        statements.push(env.DB.prepare(`INSERT INTO group_buy_products (group_buy_id, product_id, enabled) VALUES (?, ?, 1)
            ON CONFLICT(group_buy_id, product_id) DO UPDATE SET enabled = 1`).bind(groupBuy.id, productId));
    }
    await env.DB.batch(statements);
    return { data: { id: groupBuy.id, synced: true } };
}

async function getFlexContext(env, payload) {
    const groupId = String(payload?.group_id || env.LINE_DEFAULT_GROUP_ID || "").trim();
    const groupBuyId = String(payload?.group_buy_id || "").trim();
    const productId = String(payload?.product_id || "").trim();
    if (!groupId || !groupBuyId || !productId) return { error: "LINE 群組、團購與商品皆為必填", status: 400 };
    const row = await env.DB.prepare(`SELECT gb.id AS group_buy_id, gb.name AS group_buy_name, gb.ends_at, gb.status AS group_buy_status,
        p.id AS product_id, p.name AS product_name, p.specs, p.unit, p.price, p.image_url, p.enabled AS product_enabled,
        gbp.stock_enabled, gbp.sellable_quantity
        FROM group_buys gb JOIN group_buy_products gbp ON gbp.group_buy_id = gb.id AND gbp.enabled = 1
        JOIN products p ON p.id = gbp.product_id WHERE gb.id = ? AND p.id = ? LIMIT 1`).bind(groupBuyId, productId).first();
    if (!row) return { error: "找不到團購商品，請先同步團購與商品", status: 404 };
    if (row.group_buy_status !== "open" || Date.now() > new Date(row.ends_at).getTime()) return { error: "團購已截止，無法發布商品卡", status: 409 };
    if (!row.product_enabled) return { error: "商品已停售，無法發布商品卡", status: 409 };
    const flex = LineFlex.buildFlexMessage({
        groupBuy: { id: row.group_buy_id, name: row.group_buy_name, ends_at: row.ends_at },
        product: {
            id: row.product_id,
            name: row.product_name,
            specs: row.specs,
            unit: row.unit,
            price: row.price,
            image_url: row.image_url,
            stock_enabled: Boolean(row.stock_enabled),
            sellable_quantity: Number(row.sellable_quantity || 0)
        },
        showImage: payload.show_image !== false,
        quantities: payload.quantities,
        liffId: env.LIFF_ID || null
    });
    return { groupId, row, flex };
}

// 一個商品、多個口味：預設合併成一張主商品卡（見需求文件第八節）。管理者仍可選擇
// 「分開發布每個口味」，做法就是照原本 getFlexContext 對每個口味各呼叫一次，不需要另外的程式路徑。
async function getGroupFlexContext(env, payload) {
    const groupId = String(payload?.group_id || env.LINE_DEFAULT_GROUP_ID || "").trim();
    const groupBuyId = String(payload?.group_buy_id || "").trim();
    const productGroupId = String(payload?.product_group_id || "").trim();
    if (!groupId || !groupBuyId || !productGroupId) return { error: "LINE 群組、團購與主商品皆為必填", status: 400 };
    const groupBuy = await env.DB.prepare("SELECT id, name, ends_at, status FROM group_buys WHERE id = ? LIMIT 1").bind(groupBuyId).first();
    if (!groupBuy) return { error: "找不到團購，請先同步團購", status: 404 };
    if (groupBuy.status !== "open" || Date.now() > new Date(groupBuy.ends_at).getTime()) return { error: "團購已截止，無法發布商品卡", status: 409 };
    const productGroup = await env.DB.prepare("SELECT id, name, description, image_url FROM product_groups WHERE id = ? AND enabled = 1")
        .bind(productGroupId).first();
    if (!productGroup) return { error: "找不到主商品，或主商品已停用", status: 404 };
    const variants = (await env.DB.prepare(`SELECT p.id, p.name, p.variant_name, p.price, p.pickup_price, p.delivery_price, p.image_url
        FROM products p JOIN group_buy_products gbp ON gbp.product_id = p.id AND gbp.group_buy_id = ? AND gbp.enabled = 1
        WHERE p.product_group_id = ? AND p.enabled = 1 ORDER BY p.variant_sort, p.id`).bind(groupBuyId, productGroupId).all()).results;
    if (!variants.length) return { error: "此主商品目前沒有可發布的口味，請先加入團購並啟用庫存", status: 409 };
    if (!env.LIFF_ID) return { error: "尚未設定 LIFF_ID，無法發布合併商品卡；請先設定 LIFF_ID，或改用「分開發布每個口味」", status: 503 };
    const flex = LineFlex.buildGroupFlexMessage({
        groupBuy: { id: groupBuy.id, name: groupBuy.name, ends_at: groupBuy.ends_at },
        productGroup,
        variants,
        showImage: payload.show_image !== false,
        liffId: env.LIFF_ID || null
    });
    // line_flex_publications.product_id 沿用既有欄位記錄「這次發布的是什麼」；
    // 主商品群組的 id 一律是 PG 開頭，跟口味的 P 開頭 id 不會混淆。
    return { groupId, row: { group_buy_id: groupBuy.id, product_id: productGroup.id }, flex };
}

async function resolveFlexContext(env, payload) {
    if (String(payload?.product_group_id || "").trim()) return getGroupFlexContext(env, payload);
    return getFlexContext(env, payload);
}

async function publishFlexMessage(env, payload) {
    const context = await resolveFlexContext(env, payload);
    if (context.error) return context;
    const publicationId = crypto.randomUUID();
    const publishedBy = String(payload?.published_by || "後台管理員").trim().slice(0, 100) || "後台管理員";
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
        const error = "尚未設定 LINE_CHANNEL_ACCESS_TOKEN";
        await env.DB.prepare(`INSERT INTO line_flex_publications
            (id, group_id, group_buy_id, product_id, published_by, publish_status, error_message)
            VALUES (?, ?, ?, ?, ?, 'failed', ?)`).bind(publicationId, context.groupId, context.row.group_buy_id, context.row.product_id, publishedBy, error).run();
        return { error, status: 503 };
    }
    let response;
    try {
        response = await fetch("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ to: context.groupId, messages: [context.flex] })
        });
    } catch (error) {
        const message = String(error?.message || "LINE API 連線失敗").slice(0, 500);
        await env.DB.prepare(`INSERT INTO line_flex_publications
            (id, group_id, group_buy_id, product_id, published_by, publish_status, error_message)
            VALUES (?, ?, ?, ?, ?, 'failed', ?)`).bind(publicationId, context.groupId, context.row.group_buy_id, context.row.product_id, publishedBy, message).run();
        return { error: "LINE 商品卡發布失敗", status: 502 };
    }
    const responsePayload = await response.json().catch(() => ({}));
    const lineMessageId = responsePayload.sentMessages?.[0]?.id || response.headers.get("x-line-request-id") || null;
    if (!response.ok) {
        const error = String(responsePayload.message || `LINE API HTTP ${response.status}`).slice(0, 500);
        await env.DB.prepare(`INSERT INTO line_flex_publications
            (id, group_id, group_buy_id, product_id, published_by, publish_status, error_message)
            VALUES (?, ?, ?, ?, ?, 'failed', ?)`).bind(publicationId, context.groupId, context.row.group_buy_id, context.row.product_id, publishedBy, error).run();
        return { error: "LINE 商品卡發布失敗", status: 502 };
    }
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO line_flex_publications
            (id, group_id, group_buy_id, product_id, line_message_id, published_at, published_by, publish_status)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'success')`)
            .bind(publicationId, context.groupId, context.row.group_buy_id, context.row.product_id, lineMessageId, publishedBy),
        env.DB.prepare(`INSERT INTO line_groups (group_id, display_name, active_group_buy_id, last_seen_at)
            VALUES (?, '', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(group_id) DO UPDATE SET active_group_buy_id = excluded.active_group_buy_id, last_seen_at = CURRENT_TIMESTAMP`)
            .bind(context.groupId, context.row.group_buy_id)
    ]);
    return { data: { published: true, publication_id: publicationId, line_message_id: lineMessageId } };
}

async function findTargetOrder(env, customerId, prefix) {
    return env.DB.prepare(`SELECT o.id FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.customer_id = ? AND (oi.product_code = ? OR oi.product_code LIKE ?)
        ORDER BY o.created_at DESC LIMIT 1`).bind(customerId, prefix, `${prefix}-%`).first();
}

async function importInboxToActiveGroup(env, inbox) {
    const groupBuy = await env.DB.prepare(`SELECT gb.id FROM line_groups lg JOIN group_buys gb ON gb.id = lg.active_group_buy_id
        WHERE lg.group_id = ? AND gb.status = 'open' AND datetime(gb.ends_at) >= datetime('now') LIMIT 1`).bind(inbox.group_id).first();
    if (!groupBuy) return null;
    const action = inbox.action || "create";
    const parsedItems = JSON.parse(inbox.parsed_items || "[]");
    const products = [];
    for (const item of parsedItems) {
        const product = await env.DB.prepare(`SELECT p.id, p.line_code, p.price
            FROM products p JOIN group_buy_products gbp
              ON gbp.product_id = p.id AND gbp.group_buy_id = ? AND gbp.enabled = 1
            WHERE p.line_code = ? AND p.enabled = 1 LIMIT 1`)
            .bind(groupBuy.id, item.productCode).first();
        if (!product) return { error: `商品 ${item.productCode} 不存在或已停售`, status: 409 };
        products.push({ ...product, quantity: item.quantity });
    }
    const prefix = inbox.target_product_prefix || parsedItems[0]?.productCode?.split("-")[0] || "";
    const existingOrder = await env.DB.prepare("SELECT id FROM orders WHERE customer_id = ? AND group_buy_id = ? LIMIT 1")
        .bind(inbox.customer_id, groupBuy.id).first();
    if (action === "cancel" && !existingOrder) return { error: `找不到可取消的 ${prefix || "商品"} 訂單`, status: 409 };
    const orderId = existingOrder?.id || await stableId("ORD", `${inbox.customer_id}:${groupBuy.id}`);
    const existingItems = existingOrder ? (await env.DB.prepare(`SELECT oi.product_id, oi.product_code, oi.quantity, oi.unit_price
        FROM order_items oi WHERE oi.order_id = ?`).bind(orderId).all()).results : [];
    const existingByProduct = new Map(existingItems.map(item => [item.product_id, item]));
    const changesByProduct = new Map();

    if (action === "cancel" || action === "replace") {
        const matched = existingItems.filter(item =>
            !prefix || item.product_code === prefix || String(item.product_code || "").startsWith(`${prefix}-`)
        );
        if (action === "cancel" && !matched.length) return { error: `找不到可取消的 ${prefix || "商品"} 訂單`, status: 409 };
        for (const item of matched) {
            if (!item.product_id) continue;
            changesByProduct.set(item.product_id, {
                productId: item.product_id,
                productCode: item.product_code || item.product_id,
                quantity: 0,
                unitPrice: Number(item.unit_price || 0)
            });
        }
    }
    if (action !== "cancel") {
        for (const product of products) {
            const before = Number(existingByProduct.get(product.id)?.quantity || 0);
            changesByProduct.set(product.id, {
                productId: product.id,
                productCode: product.line_code || product.id,
                quantity: action === "create" ? before + Number(product.quantity || 0) : Number(product.quantity || 0),
                unitPrice: Number(product.price || 0)
            });
        }
    }
    const changes = [...changesByProduct.values()];
    if (!changes.length) return { error: "沒有可轉入的正式訂單商品", status: 409 };

    const preStatements = [];
    if (action !== "cancel") {
        preStatements.push(env.DB.prepare(`INSERT OR IGNORE INTO orders
            (id, source_message_id, customer_id, pickup_type, status, group_buy_id, line_group_id, total_amount, updated_at)
            VALUES (?, ?, ?, ?, '新訂單', ?, ?, 0, CURRENT_TIMESTAMP)`)
            .bind(orderId, inbox.message_id, inbox.customer_id, inbox.pickup_type || "", groupBuy.id, inbox.group_id));
    }
    await Inventory.executeOrderMutation(env, {
        orderId,
        groupBuyId: groupBuy.id,
        customerId: inbox.customer_id,
        changes,
        sourceType: "line_text",
        webhookEventId: inbox.webhook_event_id || null,
        preStatements,
        activeStatus: "新訂單",
        pickupType: inbox.pickup_type || null,
        notes: "LINE 文字訂單確認轉正式訂單",
        postStatements: [
            env.DB.prepare("UPDATE line_order_inbox SET status = ?, processed_at = CURRENT_TIMESTAMP, related_order_id = ? WHERE message_id = ?")
                .bind(action === "cancel" ? LineOrder.STATUS.CANCELLED : LineOrder.STATUS.IMPORTED, orderId, inbox.message_id)
        ]
    });
    return { imported: true, action, orderId, groupBuyId: groupBuy.id };
}

async function importInboxRecord(env, inbox) {
    const activeGroupResult = await importInboxToActiveGroup(env, inbox);
    if (activeGroupResult) return activeGroupResult;
    const action = inbox.action || "create";
    const items = JSON.parse(inbox.parsed_items || "[]");
    const prefix = inbox.target_product_prefix || items[0]?.productCode?.split("-")[0] || "";

    if (action === "cancel") {
        const target = await findTargetOrder(env, inbox.customer_id, prefix);
        if (!target) return { error: `找不到可取消的 ${prefix} 訂單`, status: 409 };
        await env.DB.batch([
            env.DB.prepare("DELETE FROM order_items WHERE order_id = ? AND (product_code = ? OR product_code LIKE ?)").bind(target.id, prefix, `${prefix}-%`),
            env.DB.prepare("UPDATE line_order_inbox SET status = ?, processed_at = CURRENT_TIMESTAMP, related_order_id = ? WHERE message_id = ?")
                .bind(LineOrder.STATUS.CANCELLED, target.id, inbox.message_id)
        ]);
        return { imported: true, action, orderId: target.id };
    }

    if (action === "replace") {
        const target = await findTargetOrder(env, inbox.customer_id, prefix);
        if (target) {
            await env.DB.batch([
                env.DB.prepare("DELETE FROM order_items WHERE order_id = ? AND (product_code = ? OR product_code LIKE ?)").bind(target.id, prefix, `${prefix}-%`),
                ...items.map(item => env.DB.prepare("INSERT INTO order_items (order_id, product_code, quantity) VALUES (?, ?, ?)").bind(target.id, item.productCode, item.quantity)),
                env.DB.prepare("UPDATE line_order_inbox SET status = ?, processed_at = CURRENT_TIMESTAMP, related_order_id = ? WHERE message_id = ?")
                    .bind(LineOrder.STATUS.IMPORTED, target.id, inbox.message_id)
            ]);
            return { imported: true, action, orderId: target.id };
        }
    }

    const orderId = crypto.randomUUID();
    await env.DB.batch([
        env.DB.prepare("INSERT INTO orders (id, source_message_id, customer_id, pickup_type, status) VALUES (?, ?, ?, ?, '新訂單')")
            .bind(orderId, inbox.message_id, inbox.customer_id, inbox.pickup_type || ""),
        ...items.map(item => env.DB.prepare("INSERT INTO order_items (order_id, product_code, quantity) VALUES (?, ?, ?)").bind(orderId, item.productCode, item.quantity)),
        env.DB.prepare("UPDATE line_order_inbox SET status = ?, processed_at = CURRENT_TIMESTAMP, related_order_id = ? WHERE message_id = ?")
            .bind(LineOrder.STATUS.IMPORTED, orderId, inbox.message_id)
    ]);
    return { imported: true, action, orderId };
}

function inventoryErrorJson(error) {
    return json({
        error: error.code || "INVENTORY_ERROR",
        message: error.message,
        remainingQuantity: error.remainingQuantity,
        requestedQuantity: error.requestedQuantity,
        soldQuantity: error.soldQuantity,
        sellableQuantity: error.sellableQuantity
    }, error.status || 500);
}

async function handleInventoryRoutes(request, env, url) {
    try {
        const stockList = url.pathname.match(/^\/api\/group-buys\/([^/]+)\/stock$/);
        if (stockList && request.method === "GET") {
            return json({ stocks: await Inventory.listStock(env, decodeURIComponent(stockList[1])) });
        }
        const stockItem = url.pathname.match(/^\/api\/group-buys\/([^/]+)\/stock\/([^/]+)$/);
        if (stockItem && request.method === "PUT") {
            const payload = await readJson(request);
            if (!payload) return json({ error: "INVALID_JSON", message: "JSON 格式錯誤" }, 400);
            const stock = await Inventory.configureStock(
                env,
                decodeURIComponent(stockItem[1]),
                decodeURIComponent(stockItem[2]),
                payload
            );
            return json({ stock });
        }
        const adjust = url.pathname.match(/^\/api\/group-buys\/([^/]+)\/stock\/([^/]+)\/adjust$/);
        if (adjust && request.method === "POST") {
            const payload = await readJson(request);
            if (!payload) return json({ error: "INVALID_JSON", message: "JSON 格式錯誤" }, 400);
            const stock = await Inventory.adjustStock(
                env,
                decodeURIComponent(adjust[1]),
                decodeURIComponent(adjust[2]),
                payload
            );
            return json({ stock });
        }
        const reconcile = url.pathname.match(/^\/api\/group-buys\/([^/]+)\/stock\/reconcile$/);
        if (reconcile && request.method === "GET") {
            return json({ differences: await Inventory.reconciliationPreview(env, decodeURIComponent(reconcile[1])) });
        }
        if (reconcile && request.method === "POST") {
            const payload = await readJson(request);
            if (!payload) return json({ error: "INVALID_JSON", message: "JSON 格式錯誤" }, 400);
            return json(await Inventory.applyReconciliation(env, decodeURIComponent(reconcile[1]), payload));
        }
        if (request.method === "GET" && url.pathname === "/api/inventory/alerts") {
            const groupBuyId = String(url.searchParams.get("group_buy_id") || "").trim();
            if (!groupBuyId) return json({ error: "MISSING_GROUP_BUY", message: "缺少團購編號" }, 400);
            const stocks = await Inventory.listStock(env, groupBuyId);
            return json({
                lowStock: stocks.filter(stock => stock.stockEnabled && stock.stockStatus === "low_stock"),
                soldOut: stocks.filter(stock => stock.stockEnabled && stock.stockStatus === "sold_out")
            });
        }
        if (request.method === "GET" && url.pathname === "/api/inventory/movements") {
            const groupBuyId = String(url.searchParams.get("group_buy_id") || "").trim();
            if (!groupBuyId) return json({ error: "MISSING_GROUP_BUY", message: "缺少團購編號" }, 400);
            const result = await env.DB.prepare(`SELECT * FROM inventory_movements
                WHERE group_buy_id = ? ORDER BY created_at DESC LIMIT 1000`).bind(groupBuyId).all();
            return json({ movements: result.results });
        }
        return null;
    } catch (error) {
        if (error instanceof Inventory.InventoryHttpError) return inventoryErrorJson(error);
        throw error;
    }
}

const ORDER_STATUSES = new Set(["新訂單", "已確認", "已包貨", "已完成", "已取消"]);
const PAYMENT_STATUSES = new Set(["未付款", "已付款"]);

async function normalizeOrderItems(env, groupBuyId, items) {
    if (!Array.isArray(items) || !items.length) {
        throw new Inventory.InventoryHttpError(400, "INVALID_ORDER_ITEMS", "訂單至少需要一項商品");
    }
    const seen = new Set();
    const normalized = [];
    for (const item of items) {
        const productId = String(item.productId || item.product_id || "").trim();
        if (!productId || seen.has(productId)) {
            throw new Inventory.InventoryHttpError(400, "INVALID_ORDER_ITEMS", "訂單商品不可空白或重複");
        }
        seen.add(productId);
        const product = await env.DB.prepare(`SELECT p.id, p.line_code, p.price, gbp.enabled AS group_enabled
            FROM products p JOIN group_buy_products gbp ON gbp.product_id = p.id
            WHERE gbp.group_buy_id = ? AND p.id = ? LIMIT 1`).bind(groupBuyId, productId).first();
        if (!product || !product.group_enabled) {
            throw new Inventory.InventoryHttpError(409, "PRODUCT_NOT_IN_GROUP", `商品 ${productId} 不屬於此團購`);
        }
        const quantity = Number(item.quantity);
        const unitPrice = item.unitPrice ?? item.unit_price ?? product.price;
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
            throw new Inventory.InventoryHttpError(400, "INVALID_ORDER_ITEMS", `${productId} 數量必須是 1 以上的整數`);
        }
        if (!Number.isInteger(Number(unitPrice)) || Number(unitPrice) < 0) {
            throw new Inventory.InventoryHttpError(400, "INVALID_ORDER_ITEMS", `${productId} 單價必須是 0 以上的整數`);
        }
        normalized.push({
            productId,
            productCode: product.line_code || product.id,
            quantity,
            unitPrice: Number(unitPrice)
        });
    }
    return normalized;
}

async function readAdminOrder(env, orderId) {
    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ? LIMIT 1`).bind(orderId).first();
    if (!order) return null;
    const items = (await env.DB.prepare(`SELECT oi.*, p.name AS product_name, p.specs, p.unit
        FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? ORDER BY oi.id`).bind(orderId).all()).results;
    return { ...order, items };
}

async function upsertAdminOrder(request, env, orderId) {
    const payload = await readJson(request);
    if (!payload) return json({ error: "INVALID_JSON", message: "JSON 格式錯誤" }, 400);
    const requestId = String(payload.requestId || payload.request_id || "").trim();
    const groupBuyId = String(payload.groupBuyId || payload.group_buy_id || "").trim();
    const customerId = String(payload.customerId || payload.customer_id || "").trim();
    const pickupType = String(payload.pickupType || payload.pickup_type || "").trim();
    const orderStatus = String(payload.orderStatus || payload.status || "新訂單").trim();
    const paymentStatus = String(payload.paymentStatus || payload.payment_status || "未付款").trim();
    if (!requestId) return json({ error: "REQUEST_ID_REQUIRED", message: "缺少 requestId" }, 400);
    if (!/^[A-Za-z0-9_-]{3,100}$/.test(orderId)) return json({ error: "INVALID_ORDER_ID", message: "訂單編號格式錯誤" }, 400);
    if (!groupBuyId || !customerId) return json({ error: "INVALID_ORDER", message: "團購與客戶必填" }, 400);
    if (!new Set(["自取", "外送"]).has(pickupType)) return json({ error: "INVALID_PICKUP_TYPE", message: "取貨方式錯誤" }, 400);
    if (!ORDER_STATUSES.has(orderStatus)) return json({ error: "INVALID_ORDER_STATUS", message: "訂單狀態錯誤" }, 400);
    if (!PAYMENT_STATUSES.has(paymentStatus)) return json({ error: "INVALID_PAYMENT_STATUS", message: "付款狀態錯誤" }, 400);

    const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ? LIMIT 1").bind(customerId).first();
    if (!customer) return json({ error: "CUSTOMER_NOT_FOUND", message: "找不到客戶" }, 404);
    const groupBuy = await env.DB.prepare("SELECT id FROM group_buys WHERE id = ? LIMIT 1").bind(groupBuyId).first();
    if (!groupBuy) return json({ error: "GROUP_BUY_NOT_FOUND", message: "找不到團購活動" }, 404);
    const existing = await readAdminOrder(env, orderId);
    if (existing && (existing.group_buy_id !== groupBuyId || existing.customer_id !== customerId)) {
        return json({ error: "ORDER_IDENTITY_LOCKED", message: "既有訂單不可更換團購或客戶，請另建新訂單" }, 409);
    }

    let requestedItems = [];
    if (orderStatus !== "已取消") {
        requestedItems = await normalizeOrderItems(env, groupBuyId, payload.items);
    }
    const existingItems = existing?.items || [];
    const changes = new Map(existingItems
        .filter(item => item.product_id)
        .map(item => [item.product_id, {
            productId: item.product_id,
            productCode: item.product_code || item.product_id,
            quantity: 0,
            unitPrice: Number(item.unit_price || 0)
        }]));
    for (const item of requestedItems) changes.set(item.productId, item);
    if (!changes.size) {
        if (existing) {
            await env.DB.prepare(`UPDATE orders SET payment_status = ?, notes = ?, phone_snapshot = ?,
                address_snapshot = ?, pickup_type = ?, status = '已取消', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`).bind(
                paymentStatus,
                String(payload.notes || "").trim().slice(0, 500) || null,
                String(payload.phone || "").trim().slice(0, 50) || null,
                String(payload.address || "").trim().slice(0, 200) || null,
                pickupType,
                orderId
            ).run();
            return json({ order: await readAdminOrder(env, orderId), duplicate: false });
        }
        return json({ error: "INVALID_ORDER_ITEMS", message: "新訂單至少需要一項商品" }, 400);
    }

    const sourceMessageId = `admin:${orderId}`;
    const preStatements = [
        env.DB.prepare(`INSERT OR IGNORE INTO line_order_inbox
            (message_id, group_id, line_user_id, display_name, customer_id, raw_message,
             normalized_message, parsed_items, action, pickup_type, message_time, status, processed_at, related_order_id)
            VALUES (?, '', '', '', ?, '後台手動正式訂單', '後台手動正式訂單', '[]', 'replace',
                ?, CURRENT_TIMESTAMP, '已轉正式訂單', CURRENT_TIMESTAMP, ?)`)
            .bind(sourceMessageId, customerId, pickupType, orderId),
        env.DB.prepare(`INSERT OR IGNORE INTO orders
            (id, source_message_id, customer_id, pickup_type, status, group_buy_id,
             total_amount, payment_status, notes, phone_snapshot, address_snapshot, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
            .bind(
                orderId, sourceMessageId, customerId, pickupType,
                orderStatus === "已取消" ? "新訂單" : orderStatus,
                groupBuyId, paymentStatus,
                String(payload.notes || "").trim().slice(0, 500) || null,
                String(payload.phone || "").trim().slice(0, 50) || null,
                String(payload.address || "").trim().slice(0, 200) || null
            ),
        env.DB.prepare(`UPDATE orders SET pickup_type = ?, payment_status = ?, notes = ?,
            phone_snapshot = ?, address_snapshot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(
                pickupType, paymentStatus,
                String(payload.notes || "").trim().slice(0, 500) || null,
                String(payload.phone || "").trim().slice(0, 50) || null,
                String(payload.address || "").trim().slice(0, 200) || null,
                orderId
            )
    ];
    try {
        const result = await Inventory.executeOrderMutation(env, {
            orderId,
            groupBuyId,
            customerId,
            changes: [...changes.values()],
            sourceType: "admin",
            requestId,
            preStatements,
            activeStatus: orderStatus === "已取消" ? "新訂單" : orderStatus,
            pickupType,
            notes: existing ? "後台修改正式訂單" : "後台新增正式訂單"
        });
        return json({ order: await readAdminOrder(env, orderId), duplicate: result.duplicate });
    } catch (error) {
        if (error instanceof Inventory.InventoryHttpError) return inventoryErrorJson(error);
        throw error;
    }
}

async function normalizeExcelRows(env, payload) {
    const groupBuyId = String(payload?.groupBuyId || payload?.group_buy_id || "").trim();
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!groupBuyId) throw new Inventory.InventoryHttpError(400, "MISSING_GROUP_BUY", "缺少團購編號");
    if (!rows.length || rows.length > 500) {
        throw new Inventory.InventoryHttpError(400, "INVALID_EXCEL_ROWS", "Excel 匯入需包含 1 到 500 列");
    }
    const grouped = new Map();
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] || {};
        const customerId = String(row.customerId || row.customer_id || row["客戶編號"] || "").trim();
        const productId = String(row.productId || row.product_id || row["商品編號"] || "").trim();
        const pickupType = String(row.pickupType || row.pickup_type || row["取貨方式"] || "自取").trim();
        const quantity = Number(row.quantity ?? row["數量"]);
        if (!customerId || !productId || !new Set(["自取", "外送"]).has(pickupType)
            || !Number.isInteger(quantity) || quantity < 1) {
            throw new Inventory.InventoryHttpError(400, "INVALID_EXCEL_ROWS", `Excel 第 ${index + 2} 列格式錯誤`);
        }
        const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ? LIMIT 1").bind(customerId).first();
        if (!customer) throw new Inventory.InventoryHttpError(409, "CUSTOMER_NOT_FOUND", `Excel 第 ${index + 2} 列找不到客戶 ${customerId}`);
        const product = (await normalizeOrderItems(env, groupBuyId, [{
            productId,
            quantity,
            unitPrice: row.unitPrice ?? row.unit_price ?? row["單價"]
        }]))[0];
        const key = customerId;
        if (!grouped.has(key)) grouped.set(key, { customerId, pickupType, items: new Map() });
        const group = grouped.get(key);
        if (group.pickupType !== pickupType) {
            throw new Inventory.InventoryHttpError(409, "INVALID_EXCEL_ROWS", `客戶 ${customerId} 同一批匯入不可混用取貨方式`);
        }
        const prior = group.items.get(productId);
        group.items.set(productId, { ...product, quantity: Number(prior?.quantity || 0) + quantity });
    }
    return { groupBuyId, groups: [...grouped.values()] };
}

async function previewExcelImport(env, payload) {
    const normalized = await normalizeExcelRows(env, payload);
    const demand = new Map();
    const groupDetails = [];
    for (const group of normalized.groups) {
        const existingOrder = await env.DB.prepare(`SELECT id FROM orders
            WHERE customer_id = ? AND group_buy_id = ? LIMIT 1`)
            .bind(group.customerId, normalized.groupBuyId).first();
        const orderId = existingOrder?.id || await stableId("XLS", `${normalized.groupBuyId}:${group.customerId}`);
        const currentRows = existingOrder ? (await env.DB.prepare(`SELECT product_id, quantity
            FROM order_items WHERE order_id = ?`).bind(orderId).all()).results : [];
        const current = new Map(currentRows.map(row => [row.product_id, Number(row.quantity || 0)]));
        for (const item of group.items.values()) {
            const delta = item.quantity - Number(current.get(item.productId) || 0);
            demand.set(item.productId, Number(demand.get(item.productId) || 0) + Math.max(0, delta));
        }
        groupDetails.push({ ...group, orderId, existing: Boolean(existingOrder) });
    }
    const stockChecks = [];
    let valid = true;
    for (const [productId, requestedIncrease] of demand) {
        const row = await Inventory.getStock(env, normalized.groupBuyId, productId);
        const stock = Inventory.publicStock(row);
        const enough = !stock.stockEnabled || stock.remainingQuantity >= requestedIncrease;
        valid = valid && enough;
        stockChecks.push({
            productId,
            productCode: stock.productCode,
            productName: stock.productName,
            stockEnabled: stock.stockEnabled,
            remainingQuantity: stock.remainingQuantity,
            requestedIncrease,
            shortageQuantity: enough ? 0 : requestedIncrease - stock.remainingQuantity,
            status: !stock.stockEnabled ? "stock_not_enabled"
                : stock.remainingQuantity <= 0 ? "sold_out"
                    : enough ? "ready" : "insufficient_stock"
        });
    }
    return { ...normalized, groupDetails, stockChecks, valid };
}

function publicExcelPreview(preview) {
    return {
        groupBuyId: preview.groupBuyId,
        orderCount: preview.groupDetails.length,
        rowCount: preview.groupDetails.reduce((sum, group) => sum + group.items.size, 0),
        orders: preview.groupDetails.map(group => ({
            customerId: group.customerId,
            pickupType: group.pickupType,
            orderId: group.orderId,
            existing: group.existing,
            items: [...group.items.values()]
        })),
        stockChecks: preview.stockChecks,
        valid: preview.valid
    };
}

async function confirmExcelImport(env, payload) {
    const requestId = String(payload?.requestId || payload?.request_id || "").trim();
    if (!requestId) throw new Inventory.InventoryHttpError(400, "REQUEST_ID_REQUIRED", "缺少 requestId");
    const preview = await previewExcelImport(env, payload);
    if (!preview.valid) {
        const failed = preview.stockChecks.find(check => !new Set(["ready", "stock_not_enabled"]).has(check.status));
        throw new Inventory.InventoryHttpError(
            409,
            failed.status === "sold_out" ? "SOLD_OUT" : "INSUFFICIENT_STOCK",
            failed.status === "sold_out" ? "本商品已售完" : "商品剩餘數量不足",
            { remainingQuantity: failed.remainingQuantity, requestedQuantity: failed.requestedIncrease }
        );
    }
    const entries = [];
    for (const group of preview.groupDetails) {
        const sourceMessageId = `excel:${group.orderId}`;
        const preStatements = [
            env.DB.prepare(`INSERT OR IGNORE INTO line_order_inbox
                (message_id, group_id, line_user_id, display_name, customer_id, raw_message,
                 normalized_message, parsed_items, action, pickup_type, message_time, status, processed_at, related_order_id)
                VALUES (?, '', '', '', ?, 'Excel 正式匯入', 'Excel 正式匯入', '[]', 'replace',
                    ?, CURRENT_TIMESTAMP, '已轉正式訂單', CURRENT_TIMESTAMP, ?)`)
                .bind(sourceMessageId, group.customerId, group.pickupType, group.orderId),
            env.DB.prepare(`INSERT OR IGNORE INTO orders
                (id, source_message_id, customer_id, pickup_type, status, group_buy_id, total_amount, updated_at)
                VALUES (?, ?, ?, ?, '新訂單', ?, 0, CURRENT_TIMESTAMP)`)
                .bind(group.orderId, sourceMessageId, group.customerId, group.pickupType, preview.groupBuyId)
        ];
        const options = {
            orderId: group.orderId,
            groupBuyId: preview.groupBuyId,
            customerId: group.customerId,
            changes: [...group.items.values()],
            sourceType: "excel_import",
            preStatements,
            activeStatus: "新訂單",
            pickupType: group.pickupType,
            notes: "Excel 正式確認匯入",
            requestKeyPrefix: `${requestId}:${group.orderId}`
        };
        entries.push({ prepared: await Inventory.prepareOrderMutation(env, options), options });
    }
    const result = await Inventory.executePreparedMutations(env, entries, {
        requestId,
        sourceType: "excel_import"
    });
    return { importedOrders: preview.groupDetails.length, duplicate: result.duplicate, stockChecks: preview.stockChecks };
}

async function handleOrderMutationRoutes(request, env, url) {
    const adminMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (adminMatch && request.method === "PUT") {
        return upsertAdminOrder(request, env, decodeURIComponent(adminMatch[1]));
    }
    if (request.method === "POST" && url.pathname === "/api/orders/import/preview") {
        try {
            return json(publicExcelPreview(await previewExcelImport(env, await readJson(request))));
        } catch (error) {
            if (error instanceof Inventory.InventoryHttpError) return inventoryErrorJson(error);
            throw error;
        }
    }
    if (request.method === "POST" && url.pathname === "/api/orders/import/confirm") {
        try {
            return json(await confirmExcelImport(env, await readJson(request)));
        } catch (error) {
            if (error instanceof Inventory.InventoryHttpError) return inventoryErrorJson(error);
            throw error;
        }
    }
    return null;
}

async function routeRequest(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhook/line") return handleWebhook(request, env, context, createDependencies(env));
    if (request.method === "GET" && url.pathname.startsWith("/images/")) return serveImage(env, url);
    // LIFF 客戶端路由：以 LINE id_token 驗證，繞過管理金鑰（放在管理閘門之前）。
    if (url.pathname.startsWith("/api/liff/")) {
        const handled = await Liff.handleLiffRoutes(request, env, url);
        return handled || json({ error: "Not found" }, 404);
    }
    if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/liff/") && !isAdmin(request, env)) return json({ error: "未授權" }, 401);
    if (url.pathname.startsWith("/api/products")) {
        const handled = await handleProductRoutes(request, env, url);
        if (handled) return handled;
    }
    if (url.pathname.startsWith("/api/product-groups")) {
        const handled = await handleProductGroupRoutes(request, env, url);
        if (handled) return handled;
    }
    if (url.pathname.startsWith("/api/customers")) {
        const handled = await handleCustomerRoutes(request, env, url);
        if (handled) return handled;
    }
    if (url.pathname.startsWith("/api/group-buys/") || url.pathname.startsWith("/api/inventory/")) {
        const handled = await handleInventoryRoutes(request, env, url);
        if (handled) return handled;
    }
    if (url.pathname.startsWith("/api/admin/orders/") || url.pathname.startsWith("/api/orders/import/")) {
        const handled = await handleOrderMutationRoutes(request, env, url);
        if (handled) return handled;
    }
    if (request.method === "PUT" && /^\/api\/group-buys\/[^/]+$/.test(url.pathname)) {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        payload.id = decodeURIComponent(url.pathname.split("/")[3]);
        const result = await upsertGroupBuy(env, payload);
        return result.error ? json({ error: result.error }, result.status) : json(result.data);
    }
    if (request.method === "GET" && url.pathname === "/api/line/groups") {
        const result = await env.DB.prepare("SELECT group_id, display_name, active_group_buy_id, last_seen_at FROM line_groups ORDER BY last_seen_at DESC").all();
        const groups = [...result.results];
        if (env.LINE_DEFAULT_GROUP_ID && !groups.some(group => group.group_id === env.LINE_DEFAULT_GROUP_ID)) {
            groups.unshift({ group_id: env.LINE_DEFAULT_GROUP_ID, display_name: "預設 LINE 群組", active_group_buy_id: null, last_seen_at: null });
        }
        return json(groups);
    }
    if (request.method === "POST" && url.pathname === "/api/line/flex-preview") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const result = await resolveFlexContext(env, payload);
        return result.error ? json({ error: result.error }, result.status) : json({ flex_message: result.flex });
    }
    if (request.method === "POST" && url.pathname === "/api/line/publish") {
        const payload = await readJson(request);
        if (!payload) return json({ error: "JSON 格式錯誤" }, 400);
        const result = await publishFlexMessage(env, payload);
        return result.error ? json({ error: result.error }, result.status) : json(result.data);
    }
    if (request.method === "GET" && url.pathname === "/api/line/publications") {
        const result = await env.DB.prepare("SELECT * FROM line_flex_publications ORDER BY created_at DESC LIMIT 200").all();
        return json(result.results);
    }
    if (request.method === "GET" && url.pathname === "/api/orders") {
        // 供後台把 LINE 靜默收單（Postback）訂單同步回訂單管理／商品統計／Excel（2026-07-22 驗收補齊）
        const groupBuyId = (url.searchParams.get("group_buy_id") || "").trim();
        if (!groupBuyId) return json({ error: "缺少 group_buy_id" }, 400);
        // customer_display_name：團主自訂名稱 > LINE 原始名稱 > legacy nickname（找不到客戶時為 null，
        // 由前端再回退訂單歷史名稱）。customer_nickname 保留 legacy 欄位供舊版前端相容。
        const ordersResult = await env.DB.prepare(`SELECT o.id, o.customer_id, o.group_buy_id, o.pickup_type, o.status,
                o.total_amount, o.payment_status, o.notes, o.phone_snapshot, o.address_snapshot,
                o.created_at, o.updated_at,
                c.nickname AS customer_nickname,
                ${CustomerName.resolvedNameSql("c")} AS customer_display_name,
                c.custom_display_name, c.line_display_name,
                c.pickup_type AS customer_pickup_type, c.address
            FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
            WHERE o.group_buy_id = ? ORDER BY o.created_at LIMIT 1000`).bind(groupBuyId).all();
        const itemsResult = await env.DB.prepare(`SELECT i.order_id, i.product_id, i.product_code, i.quantity,
                i.unit_price, i.amount, i.item_status, p.name AS product_name, p.specs, p.unit,
                gbp.stock_enabled, gbp.remaining_quantity, gbp.stock_status
            FROM order_items i JOIN orders o ON o.id = i.order_id
            LEFT JOIN products p ON p.id = i.product_id
            LEFT JOIN group_buy_products gbp ON gbp.group_buy_id = o.group_buy_id AND gbp.product_id = i.product_id
            WHERE o.group_buy_id = ? LIMIT 5000`).bind(groupBuyId).all();
        return json({ orders: ordersResult.results, items: itemsResult.results });
    }
    if (request.method === "GET" && url.pathname === "/api/line-inbox") {
        // customer_display_name = 目前應顯示的名稱（團主自訂優先）；customer_nickname 保留下單當時的歷史名稱。
        const rows = await env.DB.prepare(`SELECT i.*, ${CustomerName.resolvedNameSql("c")} AS customer_display_name,
                c.custom_display_name, c.line_display_name
            FROM line_order_inbox i
            LEFT JOIN customers c ON c.id = i.customer_id OR (i.customer_id IS NULL AND i.line_user_id <> '' AND c.line_user_id = i.line_user_id)
            ORDER BY i.message_time DESC LIMIT 500`).all();
        return json(rows.results);
    }
    if (request.method === "POST" && /^\/api\/line-inbox\/[^/]+\/bind-customer$/.test(url.pathname)) {
        const messageId = decodeURIComponent(url.pathname.split("/")[3]);
        const payload = await readJson(request);
        // LINE- 前綴是 stableId 產生的暫存客戶編號（小寫 hex），不可大寫化，否則會變成「改客戶編號」。
        const rawCustomerId = String(payload?.customer_id || "").trim();
        const customerId = /^LINE-/i.test(rawCustomerId) ? rawCustomerId : rawCustomerId.toUpperCase();
        if (!customerId) return json({ error: "缺少客戶編號" }, 400);
        // payload.nickname 是團主在綁定視窗指定的名稱 → 存進 custom_display_name（LINE 事件永不覆蓋）。
        const customName = String(payload?.nickname || "").trim().slice(0, 100);
        const inbox = await env.DB.prepare("SELECT message_id, line_user_id, display_name FROM line_order_inbox WHERE message_id = ?").bind(messageId).first();
        if (!inbox) return json({ error: "找不到收件紀錄" }, 404);
        if (!inbox.line_user_id) return json({ error: "此訊息沒有 LINE 使用者 ID，無法綁定" }, 409);
        const claReady = await CustomerAccounts.lineAccountsTableAvailable(env);
        // 這個 LINE 帳號目前的擁有者：先查 customer_line_accounts、再回退 legacy customers.line_user_id（migration-010）。
        const owner = await CustomerAccounts.findCustomerByLineUserId(env, inbox.line_user_id);
        const conflict = owner && owner.id !== customerId ? owner : null;
        if (conflict) {
            // LINE-<hex> 一律是 stableId 自動建立的暫存客戶（見 processPostback / liff.js），可安全合併；
            // 不再要求 profile_status 仍為 'pending'（團主可能已在客戶管理存過名稱／地址）。
            const isAutoPending = /^LINE-/i.test(conflict.id);
            if (!isAutoPending) return json({ error: `此 LINE 帳號已綁定客戶 ${conflict.id}，請先處理重複綁定` }, 409);
            // Postback 靜默收單會先建立 LINE-xxx 暫存客戶：綁定時把暫存客戶的訂單移轉到正式客戶後移除暫存列，
            // 連同它在 customer_line_accounts 的對照列（FK 指向 customers，不清會撞外鍵），
            // 避免 line_user_id 唯一衝突（2026-07-22 驗收修正）。order_change_logs 保留原值作為稽核。
            try {
                const mergeStatements = [
                    env.DB.prepare("UPDATE orders SET customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?").bind(customerId, conflict.id)
                ];
                if (claReady) mergeStatements.push(env.DB.prepare("DELETE FROM customer_line_accounts WHERE customer_id = ?").bind(conflict.id));
                mergeStatements.push(env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(conflict.id));
                await env.DB.batch(mergeStatements);
            } catch (error) {
                if (isUniqueViolation(error)) {
                    return json({ error: `客戶 ${customerId} 在同一團購已有訂單，無法自動合併暫存客戶 ${conflict.id} 的訂單，請先在訂單管理處理` }, 409);
                }
                throw error;
            }
        }
        // LINE 原始名稱：優先沿用被合併的暫存客戶所記錄的名稱，否則用收件匣當時的 LINE 顯示名稱。
        const lineDisplayName = String(conflict?.line_display_name || conflict?.nickname || inbox.display_name || "").trim().slice(0, 100) || null;
        const resolvedName = customName || lineDisplayName || customerId;
        // 沿用被合併暫存客戶的外送地址，避免客人在 LIFF 填好的地址在綁定後消失。
        const mergedAddress = conflict?.address == null || String(conflict.address).trim() === "" ? null : String(conflict.address);
        // 綁定＝「新增一個帳號」而不是「換綁」（migration-010）：客戶已有 legacy line_user_id 時不得覆蓋
        //（那是第一個帳號），只有客戶還沒有帳號時才填 legacy 欄位；第二個以上的帳號記在 customer_line_accounts。
        // 對照表尚未建立（migration-010 未套用）時退回舊行為：直接覆蓋 legacy 欄位（一客一帳號）。
        const lineUserIdUpdateSql = claReady
            ? "COALESCE(customers.line_user_id, excluded.line_user_id)"
            : "excluded.line_user_id";
        await env.DB.prepare(`INSERT INTO customers
            (id, nickname, custom_display_name, line_display_name, line_user_id, pickup_type, address, profile_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                custom_display_name = excluded.custom_display_name,
                address = COALESCE(customers.address, excluded.address),
                line_display_name = COALESCE(NULLIF(TRIM(COALESCE(excluded.line_display_name, '')), ''), customers.line_display_name),
                nickname = COALESCE(
                    NULLIF(TRIM(COALESCE(excluded.custom_display_name, '')), ''),
                    NULLIF(TRIM(COALESCE(COALESCE(NULLIF(TRIM(COALESCE(excluded.line_display_name, '')), ''), customers.line_display_name), '')), ''),
                    customers.nickname),
                line_user_id = ${lineUserIdUpdateSql},
                pickup_type = COALESCE(excluded.pickup_type, customers.pickup_type),
                profile_status = 'complete', updated_at = CURRENT_TIMESTAMP`)
            .bind(customerId, resolvedName, customName || null, lineDisplayName, inbox.line_user_id,
                String(payload?.pickup_type || "").trim() || null, mergedAddress).run();
        let lineAccountsCount = null;
        if (claReady) {
            // 這個帳號從此指向指定的正式客戶：新帳號＝INSERT；改綁＝DO UPDATE 搬 customer_id
            //（自動改綁只允許發生在 bind-customer 這裡；LINE 事件端永不搬 customer_id）。
            await env.DB.prepare(`INSERT INTO customer_line_accounts (line_user_id, customer_id, line_display_name)
                VALUES (?, ?, ?)
                ON CONFLICT(line_user_id) DO UPDATE SET customer_id = excluded.customer_id,
                    line_display_name = CASE WHEN TRIM(COALESCE(excluded.line_display_name, '')) <> ''
                        THEN excluded.line_display_name ELSE customer_line_accounts.line_display_name END`)
                .bind(inbox.line_user_id, customerId, lineDisplayName).run();
            const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM customer_line_accounts WHERE customer_id = ?").bind(customerId).first();
            lineAccountsCount = Number(countRow?.c || 0);
        }
        const updated = await env.DB.prepare(`UPDATE line_order_inbox SET customer_id = ?, customer_nickname = ?,
            status = CASE WHEN status = ? THEN ? ELSE status END
            WHERE line_user_id = ?`)
            .bind(customerId, resolvedName, LineOrder.STATUS.CUSTOMER_UNMATCHED, LineOrder.STATUS.READY, inbox.line_user_id).run();
        return json({ bound: true, customer_id: customerId, customer_display_name: resolvedName, updated_messages: updated.meta.changes, line_accounts_count: lineAccountsCount });
    }
    if (request.method === "POST" && /^\/api\/line-inbox\/[^/]+\/import$/.test(url.pathname)) {
        const messageId = decodeURIComponent(url.pathname.split("/")[3]);
        const inbox = await env.DB.prepare("SELECT * FROM line_order_inbox WHERE message_id = ?").bind(messageId).first();
        if (!inbox) return json({ error: "找不到收件紀錄" }, 404);
        if ([LineOrder.STATUS.IMPORTED, LineOrder.STATUS.CANCELLED].includes(inbox.status)) return json({ imported: false });
        if (inbox.status !== LineOrder.STATUS.READY) return json({ error: "只有『可匯入』的紀錄可以處理" }, 409);
        if (!inbox.customer_id) return json({ error: "請先配對 LINE 客戶" }, 409);
        const result = await importInboxRecord(env, inbox);
        if (result.error) return json({ error: result.error }, result.status);
        return json(result);
    }
    return new Response("Not found", { status: 404 });
}

async function fetchHandler(request, env, context) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    try {
        return withCors(await routeRequest(request, env, context));
    } catch (error) {
        console.error("Worker request failed", error);
        return withCors(json({ error: "伺服器內部錯誤" }, 500));
    }
}

module.exports = {
    fetch: fetchHandler, createDependencies, corsHeaders, isAdmin, withCors, findTargetOrder, importInboxRecord,
    validateProductPayload, handleProductRoutes, validateCustomerPayload, handleCustomerRoutes,
    validateBulkImportItem, handleCustomerBulkImport,
    processPostback, reserveWebhookEvent, validateGroupBuyPayload,
    upsertGroupBuy, getFlexContext, getGroupFlexContext, resolveFlexContext, publishFlexMessage, stableId,
    handleProductGroupRoutes
};
