const test = require("node:test");
const assert = require("node:assert/strict");
const { corsHeaders, fetch: fetchHandler, isAdmin, publishFlexMessage, withCors, validateProductPayload } = require("./index.js");

test("管理 API 必須使用 Bearer 金鑰", () => {
    const env = { ADMIN_API_KEY: "secret", LINE_CHANNEL_ACCESS_TOKEN: "line-token", LINE_CHANNEL_SECRET: "line-secret" };
    assert.equal(isAdmin(new Request("https://worker/api/line-inbox", { headers: { authorization: "Bearer secret" } }), env), true);
    assert.equal(isAdmin(new Request("https://worker/api/line-inbox"), env), false);
    assert.equal(isAdmin(new Request("https://worker/api/line-inbox", { headers: { authorization: "Bearer line-token" } }), env), false);
    assert.equal(isAdmin(new Request("https://worker/api/line-inbox", { headers: { authorization: "Bearer line-secret" } }), env), false);
});

test("CORS 回應包含固定管理網站與完整方法、標頭", () => {
    const headers = new Headers(corsHeaders());
    assert.equal(headers.get("access-control-allow-origin"), "https://player5500-ctrl.github.io");
    assert.equal(headers.get("access-control-allow-methods"), "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    assert.equal(headers.get("access-control-allow-headers"), "Content-Type, Authorization");
});

test("所有 OPTIONS 預檢請求都回傳完整 CORS", async () => {
    const response = await fetchHandler(new Request("https://worker/any-path", { method: "OPTIONS" }), {}, {});
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://player5500-ctrl.github.io");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type, Authorization");
});

test("成功、401、403、404 與 500 回應都加入 CORS", async () => {
    const origin = "https://player5500-ctrl.github.io";
    const successfulEnv = {
        ADMIN_API_KEY: "secret",
        DB: { prepare() { return { async all() { return { results: [{ message_id: "m1" }] }; } }; } }
    };
    const success = await fetchHandler(new Request("https://worker/api/line-inbox", { headers: { authorization: "Bearer secret" } }), successfulEnv, {});
    const unauthorized = await fetchHandler(new Request("https://worker/api/line-inbox"), successfulEnv, {});
    const forbidden = withCors(new Response("Forbidden", { status: 403 }));
    const notFound = await fetchHandler(new Request("https://worker/not-found"), successfulEnv, {});
    const failed = await fetchHandler(new Request("https://worker/api/line-inbox", { headers: { authorization: "Bearer secret" } }), {
        ADMIN_API_KEY: "secret",
        DB: { prepare() { throw new Error("database unavailable"); } }
    }, {});
    assert.deepEqual(await success.json(), [{ message_id: "m1" }]);
    for (const [response, status] of [[success, 200], [unauthorized, 401], [forbidden, 403], [notFound, 404], [failed, 500]]) {
        assert.equal(response.status, status);
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
    }
});

test("商品欄位驗證：名稱必填、代碼正規化、價格為非負整數", () => {
    assert.equal(validateProductPayload({}).error, "商品名稱必填");
    assert.equal(validateProductPayload({ name: "布丁", line_code: "1abc" }).error, "商品代碼格式錯誤，需以英文字母開頭，例如 A001");
    assert.equal(validateProductPayload({ name: "布丁", price: -5 }).error, "價格必須是 0 以上的整數");
    assert.equal(validateProductPayload({ name: "布丁", price: 1.5 }).error, "價格必須是 0 以上的整數");
    const ok = validateProductPayload({ name: " 布丁 ", line_code: "ａ００１", price: 60, enabled: false });
    assert.deepEqual(ok, { name: "布丁", lineCode: "A001", price: 60, pickupPrice: null, deliveryPrice: null, specs: null, unit: "份", description: null, imageUrl: null, enabled: 0 });
    // 雙價選填：缺值→null；有值須為非負整數；非法值回錯誤
    const dual = validateProductPayload({ name: "布丁", price: 60, pickup_price: 55, delivery_price: 70 });
    assert.equal(dual.pickupPrice, 55);
    assert.equal(dual.deliveryPrice, 70);
    assert.equal(validateProductPayload({ name: "布丁", price: 60, pickup_price: -1 }).error, "自取價必須是 0 以上的整數");
    assert.equal(validateProductPayload({ name: "布丁", price: 60, delivery_price: 1.5 }).error, "外送價必須是 0 以上的整數");
});

function fakeDb() {
    const calls = [];
    return {
        calls,
        async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
        prepare(sql) {
            return {
                bind(...args) {
                    calls.push({ sql, args });
                    return {
                        async run() {
                            if (/INSERT INTO products/.test(sql) && args[3] === "DUP") {
                                throw new Error("D1_ERROR: UNIQUE constraint failed: products.line_code");
                            }
                            return { meta: { changes: args.includes("missing-id") ? 0 : 1 } };
                        },
                        async first() { return null; }
                    };
                },
                async all() { return { results: [{ id: "p1", name: "布丁", line_code: "A001" }] }; }
            };
        }
    };
}

test("商品 API：列表、建立、更新、刪除與錯誤處理", async () => {
    const env = { ADMIN_API_KEY: "secret", DB: fakeDb() };
    const auth = { authorization: "Bearer secret" };

    const list = await fetchHandler(new Request("https://worker/api/products", { headers: auth }), env, {});
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), [{ id: "p1", name: "布丁", line_code: "A001" }]);

    const created = await fetchHandler(new Request("https://worker/api/products", {
        method: "POST", headers: auth, body: JSON.stringify({ name: "布丁", line_code: "A001", price: 60 })
    }), env, {});
    assert.equal(created.status, 201);
    assert.equal((await created.json()).created, true);

    const badJson = await fetchHandler(new Request("https://worker/api/products", { method: "POST", headers: auth, body: "{" }), env, {});
    assert.equal(badJson.status, 400);

    const duplicated = await fetchHandler(new Request("https://worker/api/products", {
        method: "POST", headers: auth, body: JSON.stringify({ name: "布丁", line_code: "DUP" })
    }), env, {});
    assert.equal(duplicated.status, 409);

    const updated = await fetchHandler(new Request("https://worker/api/products/p1", {
        method: "PUT", headers: auth, body: JSON.stringify({ name: "布丁", price: 70 })
    }), env, {});
    assert.equal(updated.status, 200);

    const upserted = await fetchHandler(new Request("https://worker/api/products/missing-id", {
        method: "PUT", headers: auth, body: JSON.stringify({ name: "新品", line_code: "P099", price: 50 })
    }), env, {});
    assert.equal(upserted.status, 201);
    assert.equal((await upserted.json()).created, true);

    const missing = await fetchHandler(new Request("https://worker/api/products/missing-id", {
        method: "DELETE", headers: auth
    }), env, {});
    assert.equal(missing.status, 404);

    const unauthorized = await fetchHandler(new Request("https://worker/api/products"), env, {});
    assert.equal(unauthorized.status, 401);
});

function fakeR2() {
    const store = new Map();
    return {
        store,
        async put(key, body, options) { store.set(key, { body, contentType: options?.httpMetadata?.contentType }); },
        async get(key) {
            const item = store.get(key);
            return item ? { body: item.body, httpMetadata: { contentType: item.contentType } } : null;
        }
    };
}

test("商品圖片：上傳驗證、寫入 R2 並公開讀取", async () => {
    const env = { ADMIN_API_KEY: "secret", DB: fakeDb(), IMAGES: fakeR2() };
    const auth = { authorization: "Bearer secret" };
    const png = new Uint8Array([137, 80, 78, 71]);

    const wrongType = await fetchHandler(new Request("https://worker/api/products/p1/image", {
        method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "hi"
    }), env, {});
    assert.equal(wrongType.status, 415);

    const empty = await fetchHandler(new Request("https://worker/api/products/p1/image", {
        method: "POST", headers: { ...auth, "content-type": "image/png" }, body: new Uint8Array(0)
    }), env, {});
    assert.equal(empty.status, 400);

    const dbWithProduct = fakeDb();
    dbWithProduct.prepare = (sql) => ({
        bind: (...args) => ({
            async run() { return { meta: { changes: 1 } }; },
            async first() { return /SELECT id FROM products/.test(sql) ? { id: args[0] } : null; }
        })
    });
    env.DB = dbWithProduct;
    const uploaded = await fetchHandler(new Request("https://worker/api/products/p1/image", {
        method: "POST", headers: { ...auth, "content-type": "image/png" }, body: png
    }), env, {});
    assert.equal(uploaded.status, 200);
    const payload = await uploaded.json();
    assert.match(payload.image_url, /^https:\/\/worker\/images\/products\/p1\?v=\d+$/);
    assert.equal(env.IMAGES.store.has("products/p1"), true);

    const served = await fetchHandler(new Request("https://worker/images/products/p1"), env, {});
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("cache-control"), "public, max-age=86400");

    const missing = await fetchHandler(new Request("https://worker/images/products/none"), env, {});
    assert.equal(missing.status, 404);

    const noAuth = await fetchHandler(new Request("https://worker/api/products/p1/image", {
        method: "POST", headers: { "content-type": "image/png" }, body: png
    }), env, {});
    assert.equal(noAuth.status, 401);
});

test("收件匣綁定客戶：驗證、衝突與回填", async () => {
    const auth = { authorization: "Bearer secret" };
    function bindDb({ inbox, conflict }) {
        return {
            prepare(sql) {
                return {
                    bind() {
                        return {
                            async first() {
                                if (/FROM line_order_inbox/.test(sql)) return inbox;
                                if (/FROM customers/.test(sql)) return conflict || null;
                                return null;
                            },
                            async run() { return { meta: { changes: 2 } }; }
                        };
                    }
                };
            }
        };
    }

    const noId = await fetchHandler(new Request("https://worker/api/line-inbox/m1/bind-customer", {
        method: "POST", headers: auth, body: JSON.stringify({})
    }), { ADMIN_API_KEY: "secret", DB: bindDb({ inbox: null }) }, {});
    assert.equal(noId.status, 400);

    const notFound = await fetchHandler(new Request("https://worker/api/line-inbox/m1/bind-customer", {
        method: "POST", headers: auth, body: JSON.stringify({ customer_id: "A001" })
    }), { ADMIN_API_KEY: "secret", DB: bindDb({ inbox: null }) }, {});
    assert.equal(notFound.status, 404);

    const conflicted = await fetchHandler(new Request("https://worker/api/line-inbox/m1/bind-customer", {
        method: "POST", headers: auth, body: JSON.stringify({ customer_id: "A001" })
    }), { ADMIN_API_KEY: "secret", DB: bindDb({ inbox: { message_id: "m1", line_user_id: "U1" }, conflict: { id: "A002" } }) }, {});
    assert.equal(conflicted.status, 409);

    const bound = await fetchHandler(new Request("https://worker/api/line-inbox/m1/bind-customer", {
        method: "POST", headers: auth, body: JSON.stringify({ customer_id: "a001", nickname: "陳小明" })
    }), { ADMIN_API_KEY: "secret", DB: bindDb({ inbox: { message_id: "m1", line_user_id: "U1" } }) }, {});
    assert.equal(bound.status, 200);
    const payload = await bound.json();
    assert.equal(payload.customer_id, "A001");
    assert.equal(payload.updated_messages, 2);
});

test("收件匣綁定客戶：Postback 自動建立的 LINE- 暫存客戶會被合併而不是回 409", async () => {
    const auth = { authorization: "Bearer secret" };
    const batched = [];
    const db = {
        prepare(sql) {
            return {
                bind(...args) {
                    return {
                        sql, args,
                        async first() {
                            if (/FROM line_order_inbox/.test(sql)) return { message_id: "m1", line_user_id: "U1" };
                            if (/FROM customers/.test(sql)) return { id: "LINE-abc123", profile_status: "pending" };
                            return null;
                        },
                        async run() { return { meta: { changes: 1 } }; }
                    };
                }
            };
        },
        async batch(statements) { batched.push(...statements.map(s => s.sql)); return []; }
    };
    const bound = await fetchHandler(new Request("https://worker/api/line-inbox/m1/bind-customer", {
        method: "POST", headers: auth, body: JSON.stringify({ customer_id: "A002", nickname: "Kevin" })
    }), { ADMIN_API_KEY: "secret", DB: db }, {});
    assert.equal(bound.status, 200);
    assert.equal((await bound.json()).bound, true);
    assert.equal(batched.some(sql => /UPDATE orders SET customer_id/.test(sql)), true, "應把暫存客戶的訂單移轉給正式客戶");
    assert.equal(batched.some(sql => /DELETE FROM customers/.test(sql)), true, "應移除 LINE- 暫存客戶");
});

test("LINE Webhook 只使用 /webhook/line", async () => {
    const env = { LINE_CHANNEL_SECRET: "secret" };
    const context = { waitUntil() {} };
    const webhook = await fetchHandler(new Request("https://worker/webhook/line", { method: "POST" }), env, context);
    const oldPath = await fetchHandler(new Request("https://worker/webhooks/line", { method: "POST" }), env, context);
    assert.equal(webhook.status, 401);
    assert.equal(oldPath.status, 404);
});

test("管理發布 API 會送出 Flex push 並記錄 LINE messageId", async () => {
    const calls = [];
    const db = {
        prepare(sql) {
            return {
                bind(...args) {
                    return {
                        async first() {
                            if (/FROM group_buys/.test(sql)) return {
                                group_buy_id: "GB1", group_buy_name: "七月團購", ends_at: "2099-07-31T15:59:59.000Z", group_buy_status: "open",
                                product_id: "P1", product_name: "手工蛋捲", specs: "原味", unit: "盒", price: 180,
                                image_url: "https://example.com/p1.jpg", product_enabled: 1
                            };
                            return null;
                        },
                        async run() { calls.push({ sql, args }); return { meta: { changes: 1 } }; }
                    };
                }
            };
        },
        async batch(statements) { for (const statement of statements) await statement.run(); }
    };
    const originalFetch = global.fetch;
    let requestBody;
    global.fetch = async (url, options) => {
        assert.equal(url, "https://api.line.me/v2/bot/message/push");
        assert.equal(options.headers.authorization, "Bearer line-access-token");
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({ sentMessages: [{ id: "LINE-MESSAGE-1" }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
        const result = await publishFlexMessage({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: "line-access-token" }, {
            group_id: "G1", group_buy_id: "GB1", product_id: "P1", quantities: [1, 2, 3], show_image: true
        });
        assert.equal(result.data.line_message_id, "LINE-MESSAGE-1");
        assert.equal(requestBody.to, "G1");
        assert.equal(requestBody.messages[0].type, "flex");
        assert.doesNotMatch(JSON.stringify(requestBody), /displayText/);
        assert.equal(calls.some(call => /line_flex_publications/.test(call.sql)), true);

        const beforeFailureLogs = calls.filter(call => /line_flex_publications/.test(call.sql)).length;
        global.fetch = async () => { throw new Error("offline"); };
        const failed = await publishFlexMessage({ DB: db, LINE_CHANNEL_ACCESS_TOKEN: "line-access-token" }, {
            group_id: "G1", group_buy_id: "GB1", product_id: "P1", quantities: [1]
        });
        assert.equal(failed.status, 502);
        assert.equal(calls.filter(call => /line_flex_publications/.test(call.sql)).length, beforeFailureLogs + 1);
        assert.equal(calls.some(call => call.args.includes("offline")), true);
    } finally {
        global.fetch = originalFetch;
    }
});
