const LineOrder = require("../../line-order.js");
const { handleWebhook } = require("./webhook-handler.js");
const LineFlex = require("./line-flex.js");
const Liff = require("./liff.js");
const CustomerName = require("../../customer-name.js");
const CustomerPasteParse = require("../../customer-paste-parse.js");

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
            const byLineUserId = userId
                ? await env.DB.prepare(`SELECT id, nickname, line_display_name, custom_display_name, pickup_type AS pickupType
                    FROM customers WHERE line_user_id = ? LIMIT 1`).bind(userId).first()
                : null;
            if (byLineUserId) return { ...byLineUserId, displayName: CustomerName.resolveDisplayName(byLineUserId) };
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

function normalizeLineCode(value) {
    const code = String(value || "").normalize("NFKC").toUpperCase().trim();
    return /^[A-Z][A-Z0-9_-]*$/.test(code) ? code : "";
}

function validateProductPayload(payload) {
    const name = String(payload.name || "").trim();
    if (!name) return { error: "商品名稱必填" };
    const rawCode = payload.line_code == null ? "" : String(payload.line_code).trim();
    const lineCode = rawCode ? normalizeLineCode(rawCode) : null;
    if (rawCode && !lineCode) return { error: "商品代碼格式錯誤，需以英文字母開頭，例如 A001" };
    const price = Number(payload.price ?? 0);
    if (!Number.isInteger(price) || price < 0) return { error: "價格必須是 0 以上的整數" };
    // 雙價：自取價／外送價為選填，缺值存 null（下單時回退 legacy price，見 liff.js effectivePrice）。
    const parseOptionalPrice = (value, label) => {
        if (value == null || value === "") return { value: null };
        const num = Number(value);
        if (!Number.isInteger(num) || num < 0) return { error: `${label}必須是 0 以上的整數` };
        return { value: num };
    };
    const pickup = parseOptionalPrice(payload.pickup_price, "自取價");
    if (pickup.error) return { error: pickup.error };
    const delivery = parseOptionalPrice(payload.delivery_price, "外送價");
    if (delivery.error) return { error: delivery.error };
    return {
        name,
        lineCode,
        price,
        pickupPrice: pickup.value,
        deliveryPrice: delivery.value,
        specs: String(payload.specs || "").trim() || null,
        unit: String(payload.unit || "").trim() || "份",
        description: String(payload.description || "").trim() || null,
        imageUrl: String(payload.image_url || "").trim() || null,
        enabled: payload.enabled === undefined ? 1 : (payload.enabled ? 1 : 0)
    };
}

async function readJson(request) {
    try { return await request.json(); } catch (_error) { return null; }
}

function isUniqueViolation(error) {
    return /UNIQUE constraint failed/i.test(error?.message || "");
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

// ==========================================================================
// 客戶管理 API（後台）
// 團主在「客戶管理」修改的名稱必須存到雲端，否則只留在瀏覽器 localStorage，
// 下次同步就會被 D1 的 LINE 原始名稱蓋回去（這是「訂單仍顯示蜜茶」的直接原因之一）。
// 這裡只寫 custom_display_name / pickup_type / address / notes，
// 永不寫 line_user_id 與 line_display_name（識別碼與 LINE 原始名稱由 Webhook 維護）。
// notes（備註／本名）同理：只存在 localStorage 的話換裝置就消失，所以 migration-008 之後一律存雲端。
// ==========================================================================
function customerSelectSql() {
    return `SELECT id, nickname, line_display_name, custom_display_name, line_user_id, pickup_type, address, notes,
        profile_status, created_at, updated_at, ${CustomerName.resolvedNameSql()} AS customer_display_name
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
    if (request.method === "GET" && url.pathname === "/api/customers") {
        const rows = await env.DB.prepare(`${customerSelectSql()} ORDER BY id LIMIT 2000`).all();
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
        const row = await env.DB.prepare(`${customerSelectSql()} WHERE id = ? LIMIT 1`).bind(id).first();
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
        const row = await env.DB.prepare(`${customerSelectSql()} WHERE id = ? LIMIT 1`).bind(id).first();
        return json({ id, updated: true, customer: row });
    }

    if (request.method === "DELETE") {
        // 有訂單紀錄的客戶不可刪除（與前端規則一致，保護訂單參照與稽核）。
        const ordered = await env.DB.prepare("SELECT 1 FROM orders WHERE customer_id = ? LIMIT 1").bind(id).first();
        if (ordered) return json({ error: "此客戶已有訂單紀錄，不可刪除" }, 409);
        const result = await env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
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

        const existingCustomer = await env.DB.prepare(`SELECT id, nickname, line_display_name, custom_display_name
            FROM customers WHERE line_user_id = ? LIMIT 1`).bind(record.lineUserId).first();
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

        const statements = [
            env.DB.prepare(CustomerName.CUSTOMER_UPSERT_SQL)
                .bind(customerId, lineDisplayName || "LINE 客戶", lineDisplayName || null, record.lineUserId)
        ];

        if (parsed.action === "view_order") {
            statements.push(env.DB.prepare("UPDATE line_webhook_events SET process_status = 'processed', error_message = NULL, processed_at = CURRENT_TIMESTAMP WHERE webhook_event_id = ?")
                .bind(record.webhookEventId));
            await env.DB.batch(statements);
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

        if (parsed.action === "set_quantity") {
            statements.push(
                inboxInsert,
                env.DB.prepare(`INSERT OR IGNORE INTO orders
                    (id, source_message_id, customer_id, pickup_type, status, group_buy_id, line_group_id, total_amount, updated_at)
                    VALUES (?, ?, ?, '', '新訂單', ?, ?, 0, CURRENT_TIMESTAMP)`)
                    .bind(orderId, `postback:${record.webhookEventId}`, customerId, parsed.groupBuyId, record.groupId),
                env.DB.prepare(`INSERT INTO order_items
                    (order_id, product_code, product_id, quantity, unit_price, amount, item_status, updated_at)
                    VALUES (?, ?, ?, ?, ?, ? * ?, 'active', CURRENT_TIMESTAMP)
                    ON CONFLICT(order_id, product_id) DO UPDATE SET quantity = excluded.quantity,
                    product_code = excluded.product_code, unit_price = excluded.unit_price, amount = excluded.amount,
                    item_status = 'active', updated_at = CURRENT_TIMESTAMP`)
                    .bind(orderId, context.line_code || context.product_id, context.product_id, parsed.quantity, context.price, context.price, parsed.quantity)
            );
        } else {
            statements.push(
                inboxInsert,
                env.DB.prepare("DELETE FROM order_items WHERE order_id = ? AND product_id = ?").bind(orderId, parsed.productId)
            );
        }

        statements.push(
            env.DB.prepare(`UPDATE orders SET total_amount = COALESCE((SELECT SUM(amount) FROM order_items WHERE order_id = ?), 0),
                status = CASE WHEN EXISTS(SELECT 1 FROM order_items WHERE order_id = ?) THEN '新訂單' ELSE '已取消' END,
                line_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(orderId, orderId, record.groupId, orderId),
            env.DB.prepare(`INSERT INTO order_change_logs
                (id, order_id, customer_id, group_buy_id, product_id, action, quantity_before, quantity_after, source_type, webhook_event_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'line_postback', ?)`)
                .bind(crypto.randomUUID(), existingOrder || parsed.action === "set_quantity" ? orderId : null, customerId, parsed.groupBuyId,
                    parsed.productId, parsed.action, quantityBefore, parsed.quantity || 0, record.webhookEventId),
            env.DB.prepare("UPDATE line_webhook_events SET process_status = 'processed', error_message = NULL, processed_at = CURRENT_TIMESTAMP WHERE webhook_event_id = ?")
                .bind(record.webhookEventId)
        );
        await env.DB.batch(statements);
        return { processed: true, action: parsed.action, orderId, quantity: parsed.quantity || 0 };
    } catch (error) {
        await markWebhookFailed(env, record.webhookEventId, error?.message || "Postback 處理失敗");
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
        .bind(groupBuy.id, groupBuy.name, groupBuy.startsAt, groupBuy.endsAt, groupBuy.status, groupBuy.notes)];
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
        p.id AS product_id, p.name AS product_name, p.specs, p.unit, p.price, p.image_url, p.enabled AS product_enabled
        FROM group_buys gb JOIN group_buy_products gbp ON gbp.group_buy_id = gb.id AND gbp.enabled = 1
        JOIN products p ON p.id = gbp.product_id WHERE gb.id = ? AND p.id = ? LIMIT 1`).bind(groupBuyId, productId).first();
    if (!row) return { error: "找不到團購商品，請先同步團購與商品", status: 404 };
    if (row.group_buy_status !== "open" || Date.now() > new Date(row.ends_at).getTime()) return { error: "團購已截止，無法發布商品卡", status: 409 };
    if (!row.product_enabled) return { error: "商品已停售，無法發布商品卡", status: 409 };
    const flex = LineFlex.buildFlexMessage({
        groupBuy: { id: row.group_buy_id, name: row.group_buy_name, ends_at: row.ends_at },
        product: { id: row.product_id, name: row.product_name, specs: row.specs, unit: row.unit, price: row.price, image_url: row.image_url },
        showImage: payload.show_image !== false,
        quantities: payload.quantities,
        liffId: env.LIFF_ID || null
    });
    return { groupId, row, flex };
}

async function publishFlexMessage(env, payload) {
    const context = await getFlexContext(env, payload);
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
        const product = await env.DB.prepare("SELECT id, line_code, price FROM products WHERE line_code = ? AND enabled = 1 LIMIT 1")
            .bind(item.productCode).first();
        if (!product) return { error: `商品 ${item.productCode} 不存在或已停售`, status: 409 };
        products.push({ ...product, quantity: item.quantity });
    }
    const prefix = inbox.target_product_prefix || parsedItems[0]?.productCode?.split("-")[0] || "";
    const existingOrder = await env.DB.prepare("SELECT id FROM orders WHERE customer_id = ? AND group_buy_id = ? LIMIT 1")
        .bind(inbox.customer_id, groupBuy.id).first();
    if (action === "cancel" && !existingOrder) return { error: `找不到可取消的 ${prefix || "商品"} 訂單`, status: 409 };
    const orderId = existingOrder?.id || await stableId("ORD", `${inbox.customer_id}:${groupBuy.id}`);
    const previousQuantities = new Map();
    if (existingOrder) {
        for (const product of products) {
            const row = await env.DB.prepare("SELECT quantity FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1")
                .bind(orderId, product.id).first();
            previousQuantities.set(product.id, Number(row?.quantity || 0));
        }
    }
    const statements = [
        env.DB.prepare(`INSERT OR IGNORE INTO orders
            (id, source_message_id, customer_id, pickup_type, status, group_buy_id, line_group_id, total_amount, updated_at)
            VALUES (?, ?, ?, ?, '新訂單', ?, ?, 0, CURRENT_TIMESTAMP)`)
            .bind(orderId, inbox.message_id, inbox.customer_id, inbox.pickup_type || "", groupBuy.id, inbox.group_id)
    ];
    if (action === "cancel") {
        statements.push(env.DB.prepare("DELETE FROM order_items WHERE order_id = ? AND (product_code = ? OR product_code LIKE ?)")
            .bind(orderId, prefix, `${prefix}-%`));
    } else {
        if (action === "replace") {
            statements.push(env.DB.prepare("DELETE FROM order_items WHERE order_id = ? AND (product_code = ? OR product_code LIKE ?)")
                .bind(orderId, prefix, `${prefix}-%`));
        }
        for (const product of products) {
            const conflictUpdate = action === "create"
                ? "quantity = order_items.quantity + excluded.quantity, amount = (order_items.quantity + excluded.quantity) * excluded.unit_price"
                : "quantity = excluded.quantity, amount = excluded.amount";
            statements.push(env.DB.prepare(`INSERT INTO order_items
                (order_id, product_code, product_id, quantity, unit_price, amount, item_status, updated_at)
                VALUES (?, ?, ?, ?, ?, ? * ?, 'active', CURRENT_TIMESTAMP)
                ON CONFLICT(order_id, product_id) DO UPDATE SET ${conflictUpdate}, unit_price = excluded.unit_price,
                product_code = excluded.product_code, item_status = 'active', updated_at = CURRENT_TIMESTAMP`)
                .bind(orderId, product.line_code || product.id, product.id, product.quantity, product.price, product.price, product.quantity));
            const before = previousQuantities.get(product.id) || 0;
            const after = action === "create" ? before + product.quantity : product.quantity;
            statements.push(env.DB.prepare(`INSERT INTO order_change_logs
                (id, order_id, customer_id, group_buy_id, product_id, action, quantity_before, quantity_after, source_type, webhook_event_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'line_text', ?)`)
                .bind(crypto.randomUUID(), orderId, inbox.customer_id, groupBuy.id, product.id, action, before, after, inbox.webhook_event_id || null));
        }
    }
    statements.push(
        env.DB.prepare(`UPDATE orders SET total_amount = COALESCE((SELECT SUM(amount) FROM order_items WHERE order_id = ?), 0),
            status = CASE WHEN EXISTS(SELECT 1 FROM order_items WHERE order_id = ?) THEN '新訂單' ELSE '已取消' END,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(orderId, orderId, orderId),
        env.DB.prepare("UPDATE line_order_inbox SET status = ?, processed_at = CURRENT_TIMESTAMP, related_order_id = ? WHERE message_id = ?")
            .bind(action === "cancel" ? LineOrder.STATUS.CANCELLED : LineOrder.STATUS.IMPORTED, orderId, inbox.message_id)
    );
    await env.DB.batch(statements);
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
    if (url.pathname.startsWith("/api/customers")) {
        const handled = await handleCustomerRoutes(request, env, url);
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
        const result = await getFlexContext(env, payload);
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
                o.total_amount, o.created_at, o.updated_at,
                c.nickname AS customer_nickname,
                ${CustomerName.resolvedNameSql("c")} AS customer_display_name,
                c.custom_display_name, c.line_display_name,
                c.pickup_type AS customer_pickup_type, c.address
            FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
            WHERE o.group_buy_id = ? ORDER BY o.created_at LIMIT 1000`).bind(groupBuyId).all();
        const itemsResult = await env.DB.prepare(`SELECT i.order_id, i.product_id, i.product_code, i.quantity,
                i.unit_price, i.amount, i.item_status, p.name AS product_name, p.specs, p.unit
            FROM order_items i JOIN orders o ON o.id = i.order_id
            LEFT JOIN products p ON p.id = i.product_id
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
        const conflict = await env.DB.prepare(`SELECT id, profile_status, nickname, line_display_name, address
            FROM customers WHERE line_user_id = ? AND id <> ?`).bind(inbox.line_user_id, customerId).first();
        if (conflict) {
            // LINE-<hex> 一律是 stableId 自動建立的暫存客戶（見 processPostback / liff.js），可安全合併；
            // 不再要求 profile_status 仍為 'pending'（團主可能已在客戶管理存過名稱／地址）。
            const isAutoPending = /^LINE-/i.test(conflict.id);
            if (!isAutoPending) return json({ error: `此 LINE 帳號已綁定客戶 ${conflict.id}，請先處理重複綁定` }, 409);
            // Postback 靜默收單會先建立 LINE-xxx 暫存客戶：綁定時把暫存客戶的訂單移轉到正式客戶後移除暫存列，
            // 避免 line_user_id 唯一衝突（2026-07-22 驗收修正）。order_change_logs 保留原值作為稽核。
            try {
                await env.DB.batch([
                    env.DB.prepare("UPDATE orders SET customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?").bind(customerId, conflict.id),
                    env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(conflict.id)
                ]);
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
                line_user_id = excluded.line_user_id,
                pickup_type = COALESCE(excluded.pickup_type, customers.pickup_type),
                profile_status = 'complete', updated_at = CURRENT_TIMESTAMP`)
            .bind(customerId, resolvedName, customName || null, lineDisplayName, inbox.line_user_id,
                String(payload?.pickup_type || "").trim() || null, mergedAddress).run();
        const updated = await env.DB.prepare(`UPDATE line_order_inbox SET customer_id = ?, customer_nickname = ?,
            status = CASE WHEN status = ? THEN ? ELSE status END
            WHERE line_user_id = ?`)
            .bind(customerId, resolvedName, LineOrder.STATUS.CUSTOMER_UNMATCHED, LineOrder.STATUS.READY, inbox.line_user_id).run();
        return json({ bound: true, customer_id: customerId, customer_display_name: resolvedName, updated_messages: updated.meta.changes });
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
    upsertGroupBuy, getFlexContext, publishFlexMessage, stableId
};
