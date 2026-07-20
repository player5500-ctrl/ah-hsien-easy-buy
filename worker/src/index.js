const LineOrder = require("../../line-order.js");
const { handleWebhook } = require("./webhook-handler.js");

function corsHeaders(request, env) {
    const origin = request.headers.get("origin") || "";
    if (!env.ADMIN_ORIGIN || origin !== env.ADMIN_ORIGIN) return {};
    return {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "vary": "Origin"
    };
}

function json(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function isAdmin(request, env) {
    const authorization = request.headers.get("authorization") || "";
    return Boolean(env.ADMIN_API_KEY) && authorization === `Bearer ${env.ADMIN_API_KEY}`;
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

async function fetchHandler(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/line") return handleWebhook(request, env, context, createDependencies(env));
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) return new Response(null, { status: 204, headers: cors });
    if (url.pathname.startsWith("/api/") && !isAdmin(request, env)) return json({ error: "未授權" }, 401, cors);
    if (request.method === "GET" && url.pathname === "/api/line-inbox") {
        const rows = await env.DB.prepare("SELECT * FROM line_order_inbox ORDER BY message_time DESC LIMIT 500").all();
        return json(rows.results, 200, cors);
    }
    if (request.method === "POST" && /^\/api\/line-inbox\/[^/]+\/import$/.test(url.pathname)) {
        const messageId = decodeURIComponent(url.pathname.split("/")[3]);
        const inbox = await env.DB.prepare("SELECT * FROM line_order_inbox WHERE message_id = ?").bind(messageId).first();
        if (!inbox) return json({ error: "找不到收件紀錄" }, 404, cors);
        if ([LineOrder.STATUS.IMPORTED, LineOrder.STATUS.CANCELLED].includes(inbox.status)) return json({ imported: false }, 200, cors);
        if (inbox.status !== LineOrder.STATUS.READY) return json({ error: "只有『可匯入』的紀錄可以處理" }, 409, cors);
        if (!inbox.customer_id) return json({ error: "請先配對 LINE 客戶" }, 409, cors);
        const result = await importInboxRecord(env, inbox);
        if (result.error) return json({ error: result.error }, result.status, cors);
        return json(result, 200, cors);
    }
    return new Response("Not found", { status: 404 });
}

module.exports = { fetch: fetchHandler, createDependencies, corsHeaders, isAdmin, findTargetOrder, importInboxRecord };
