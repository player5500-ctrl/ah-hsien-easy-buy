const LineOrder = require("../../line-order.js");
const { handleWebhook } = require("./webhook-handler.js");

const ADMIN_ORIGIN = "https://player5500-ctrl.github.io";

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": ADMIN_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key"
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
            const response = await fetch(`https://api.line.me/v2/bot/${conversationType}/${encodeURIComponent(conversationId)}/member/${encodeURIComponent(userId)}`, {
                headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
            });
            return response.ok ? (await response.json()).displayName || "" : "";
        },
        async getProductCodes() {
            const result = await env.DB.prepare("SELECT line_code FROM products WHERE enabled = 1 AND line_code IS NOT NULL").all();
            return result.results.map(row => row.line_code);
        },
        async findCustomer(userId, displayName) {
            return env.DB.prepare("SELECT id, nickname, pickup_type AS pickupType FROM customers WHERE line_user_id = ? OR (line_user_id IS NULL AND nickname = ?) LIMIT 1")
                .bind(userId, displayName).first();
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
    return {
        name,
        lineCode,
        price,
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
            await env.DB.prepare("INSERT INTO products (id, name, enabled, line_code, price, description, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)")
                .bind(id, product.name, product.enabled, product.lineCode, product.price, product.description, product.imageUrl).run();
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
            result = await env.DB.prepare("UPDATE products SET name = ?, enabled = ?, line_code = ?, price = ?, description = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(product.name, product.enabled, product.lineCode, product.price, product.description, product.imageUrl, id).run();
        } catch (error) {
            if (isUniqueViolation(error)) return json({ error: `商品代碼 ${product.lineCode} 已存在` }, 409);
            throw error;
        }
        if (!result.meta.changes) {
            try {
                await env.DB.prepare("INSERT INTO products (id, name, enabled, line_code, price, description, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)")
                    .bind(id, product.name, product.enabled, product.lineCode, product.price, product.description, product.imageUrl).run();
            } catch (error) {
                if (isUniqueViolation(error)) return json({ error: `商品代碼 ${product.lineCode} 已存在` }, 409);
                throw error;
            }
            return json({ id, created: true }, 201);
        }
        return json({ id, updated: true });
    }
    if (request.method === "DELETE") {
        const result = await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
        if (!result.meta.changes) return json({ error: "找不到商品" }, 404);
        return json({ id, deleted: true });
    }
    return null;
}

async function findTargetOrder(env, customerId, prefix) {
    return env.DB.prepare(`SELECT o.id FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.customer_id = ? AND (oi.product_code = ? OR oi.product_code LIKE ?)
        ORDER BY o.created_at DESC LIMIT 1`).bind(customerId, prefix, `${prefix}-%`).first();
}

async function importInboxRecord(env, inbox) {
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
    if (url.pathname.startsWith("/api/") && !isAdmin(request, env)) return json({ error: "未授權" }, 401);
    if (url.pathname.startsWith("/api/products")) {
        const handled = await handleProductRoutes(request, env, url);
        if (handled) return handled;
    }
    if (request.method === "GET" && url.pathname === "/api/line-inbox") {
        const rows = await env.DB.prepare("SELECT * FROM line_order_inbox ORDER BY message_time DESC LIMIT 500").all();
        return json(rows.results);
    }
    if (request.method === "POST" && /^\/api\/line-inbox\/[^/]+\/bind-customer$/.test(url.pathname)) {
        const messageId = decodeURIComponent(url.pathname.split("/")[3]);
        const payload = await readJson(request);
        const customerId = String(payload?.customer_id || "").trim().toUpperCase();
        if (!customerId) return json({ error: "缺少客戶編號" }, 400);
        const nickname = String(payload?.nickname || "").trim() || customerId;
        const inbox = await env.DB.prepare("SELECT message_id, line_user_id FROM line_order_inbox WHERE message_id = ?").bind(messageId).first();
        if (!inbox) return json({ error: "找不到收件紀錄" }, 404);
        if (!inbox.line_user_id) return json({ error: "此訊息沒有 LINE 使用者 ID，無法綁定" }, 409);
        const conflict = await env.DB.prepare("SELECT id FROM customers WHERE line_user_id = ? AND id <> ?").bind(inbox.line_user_id, customerId).first();
        if (conflict) return json({ error: `此 LINE 帳號已綁定客戶 ${conflict.id}，請先處理重複綁定` }, 409);
        await env.DB.prepare(`INSERT INTO customers (id, nickname, line_user_id, pickup_type) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, line_user_id = excluded.line_user_id`)
            .bind(customerId, nickname, inbox.line_user_id, String(payload?.pickup_type || "").trim() || null).run();
        const updated = await env.DB.prepare(`UPDATE line_order_inbox SET customer_id = ?, customer_nickname = ?,
            status = CASE WHEN status = ? THEN ? ELSE status END
            WHERE line_user_id = ?`)
            .bind(customerId, nickname, LineOrder.STATUS.CUSTOMER_UNMATCHED, LineOrder.STATUS.READY, inbox.line_user_id).run();
        return json({ bound: true, customer_id: customerId, updated_messages: updated.meta.changes });
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

module.exports = { fetch: fetchHandler, createDependencies, corsHeaders, isAdmin, withCors, findTargetOrder, importInboxRecord, validateProductPayload, handleProductRoutes };
