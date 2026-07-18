const { handleWebhook } = require("./webhook-handler.js");

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function createDependencies(env) {
    return {
        async hasMessage(messageId) {
            return Boolean(await env.DB.prepare("SELECT 1 FROM line_order_inbox WHERE message_id = ? LIMIT 1").bind(messageId).first());
        },
        async getDisplayName(groupId, userId) {
            if (!userId || !env.LINE_CHANNEL_ACCESS_TOKEN) return "";
            const response = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`, {
                headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
            });
            return response.ok ? (await response.json()).displayName || "" : "";
        },
        async getProductCodes() {
            const result = await env.DB.prepare("SELECT line_code FROM products WHERE enabled = 1 AND line_code IS NOT NULL").all();
            return result.results.map(row => row.line_code);
        },
        async findCustomer(userId, displayName) {
            return env.DB.prepare("SELECT id, nickname, pickup_type AS pickupType FROM customers WHERE line_user_id = ? OR (line_user_id IS NULL AND nickname = ?) LIMIT 1").bind(userId, displayName).first();
        },
        async isSuspectedDuplicate(record) {
            const result = await env.DB.prepare("SELECT 1 FROM line_order_inbox WHERE group_id = ? AND line_user_id = ? AND normalized_message = ? AND message_time BETWEEN datetime(?, '-5 minutes') AND datetime(?, '+5 minutes') LIMIT 1")
                .bind(record.groupId, record.lineUserId, record.normalizedMessage, record.messageTime, record.messageTime).first();
            return Boolean(result);
        },
        async insertInbox(record) {
            await env.DB.prepare(`INSERT OR IGNORE INTO line_order_inbox
                (message_id, group_id, line_user_id, display_name, customer_id, customer_nickname, raw_message, normalized_message, parsed_items, pickup_type, message_time, status, error_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(record.messageId, record.groupId, record.lineUserId, record.displayName, record.customerId || null, record.customerNickname || null,
                    record.rawMessage, record.normalizedMessage, JSON.stringify(record.parsedItems), record.pickupType || null, record.messageTime, record.status, record.errorReason || null).run();
        }
    };
}

async function fetchHandler(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/line") return handleWebhook(request, env, context, createDependencies(env));
    if (request.method === "GET" && url.pathname === "/api/line-inbox") {
        const rows = await env.DB.prepare("SELECT * FROM line_order_inbox ORDER BY message_time DESC LIMIT 500").all();
        return json(rows.results);
    }
    if (request.method === "POST" && /^\/api\/line-inbox\/[^/]+\/import$/.test(url.pathname)) {
        const messageId = decodeURIComponent(url.pathname.split("/")[3]);
        const inbox = await env.DB.prepare("SELECT * FROM line_order_inbox WHERE message_id = ?").bind(messageId).first();
        if (!inbox) return json({ error: "找不到收件資料" }, 404);
        if (inbox.status === "已轉正式訂單") return json({ imported: false });
        if (inbox.status !== "已解析") return json({ error: "只有已解析資料可轉單" }, 409);
        if (!inbox.customer_id) return json({ error: "請先綁定 LINE 客戶" }, 409);
        const orderId = crypto.randomUUID();
        const items = JSON.parse(inbox.parsed_items || "[]");
        const statements = [
            env.DB.prepare("INSERT INTO orders (id, source_message_id, customer_id, pickup_type, status) VALUES (?, ?, ?, ?, '新訂單')")
                .bind(orderId, messageId, inbox.customer_id, inbox.pickup_type || ""),
            ...items.map(item => env.DB.prepare("INSERT INTO order_items (order_id, product_code, quantity) VALUES (?, ?, ?)").bind(orderId, item.productCode, item.quantity)),
            env.DB.prepare("UPDATE line_order_inbox SET status = '已轉正式訂單', processed_at = CURRENT_TIMESTAMP WHERE message_id = ?").bind(messageId)
        ];
        await env.DB.batch(statements);
        return json({ imported: true, orderId });
    }
    return new Response("Not found", { status: 404 });
}

module.exports = { fetch: fetchHandler, createDependencies };
