const LineOrder = require("../../line-order.js");
const { handleWebhook } = require("./webhook-handler.js");
const LineFlex = require("./line-flex.js");

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
        async findCustomer(userId, displayName) {
            return env.DB.prepare("SELECT id, nickname, pickup_type AS pickupType FROM customers WHERE line_user_id = ? OR (line_user_id IS NULL AND nickname = ?) LIMIT 1")
                .bind(userId, displayName).first();
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
    return {
        name,
        lineCode,
        price,
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
            await env.DB.prepare("INSERT INTO products (id, name, enabled, line_code, price, specs, unit, description, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)")
                .bind(id, product.name, product.enabled, product.lineCode, product.price, product.specs, product.unit, product.description, product.imageUrl).run();
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
            result = await env.DB.prepare("UPDATE products SET name = ?, enabled = ?, line_code = ?, price = ?, specs = ?, unit = ?, description = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(product.name, product.enabled, product.lineCode, product.price, product.specs, product.unit, product.description, product.imageUrl, id).run();
        } catch (error) {
            if (isUniqueViolation(error)) return json({ error: `商品代碼 ${product.lineCode} 已存在` }, 409);
            throw error;
        }
        if (!result.meta.changes) {
            try {
                await env.DB.prepare("INSERT INTO products (id, name, enabled, line_code, price, specs, unit, description, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)")
                    .bind(id, product.name, product.enabled, product.lineCode, product.price, product.specs, product.unit, product.description, product.imageUrl).run();
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

        const existingCustomer = await env.DB.prepare("SELECT id, nickname FROM customers WHERE line_user_id = ? LIMIT 1").bind(record.lineUserId).first();
        const customerId = existingCustomer?.id || await stableId("LINE", record.lineUserId);
        const customerName = String(record.displayName || "LINE 客戶").slice(0, 100);
        const existingOrder = await env.DB.prepare("SELECT id FROM orders WHERE customer_id = ? AND group_buy_id = ? LIMIT 1")
            .bind(customerId, parsed.groupBuyId).first();
        const orderId = existingOrder?.id || await stableId("ORD", `${customerId}:${parsed.groupBuyId}`);
        const previousItem = existingOrder ? await env.DB.prepare("SELECT quantity FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1")
            .bind(orderId, parsed.productId).first() : null;
        const quantityBefore = Number(previousItem?.quantity || 0);

        const statements = [
            env.DB.prepare(`INSERT INTO customers (id, nickname, line_user_id, pickup_type, profile_status, created_at, updated_at)
                VALUES (?, ?, ?, NULL, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(line_user_id) DO UPDATE SET nickname = CASE
                    WHEN customers.profile_status = 'pending' AND excluded.nickname <> '' THEN excluded.nickname ELSE customers.nickname END,
                updated_at = CURRENT_TIMESTAMP`).bind(customerId, customerName, record.lineUserId)
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
                customerName, inboxCustomerId, existingCustomer?.nickname || null,
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
        quantities: payload.quantities
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
    if (url.pathname.startsWith("/api/") && !isAdmin(request, env)) return json({ error: "未授權" }, 401);
    if (url.pathname.startsWith("/api/products")) {
        const handled = await handleProductRoutes(request, env, url);
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
        const ordersResult = await env.DB.prepare(`SELECT o.id, o.customer_id, o.group_buy_id, o.pickup_type, o.status,
                o.total_amount, o.created_at, o.updated_at,
                c.nickname AS customer_nickname, c.pickup_type AS customer_pickup_type
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
        const conflict = await env.DB.prepare("SELECT id, profile_status FROM customers WHERE line_user_id = ? AND id <> ?").bind(inbox.line_user_id, customerId).first();
        if (conflict) {
            const isAutoPending = conflict.profile_status === "pending" && /^LINE-/.test(conflict.id);
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
        await env.DB.prepare(`INSERT INTO customers (id, nickname, line_user_id, pickup_type, profile_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, line_user_id = excluded.line_user_id,
            pickup_type = COALESCE(excluded.pickup_type, customers.pickup_type), profile_status = 'complete', updated_at = CURRENT_TIMESTAMP`)
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

module.exports = {
    fetch: fetchHandler, createDependencies, corsHeaders, isAdmin, withCors, findTargetOrder, importInboxRecord,
    validateProductPayload, handleProductRoutes, processPostback, reserveWebhookEvent, validateGroupBuyPayload,
    upsertGroupBuy, getFlexContext, publishFlexMessage, stableId
};
