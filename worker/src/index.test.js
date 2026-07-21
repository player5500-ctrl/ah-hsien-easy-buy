const test = require("node:test");
const assert = require("node:assert/strict");
const { corsHeaders, fetch: fetchHandler, isAdmin, withCors } = require("./index.js");

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
    assert.equal(headers.get("access-control-allow-headers"), "Content-Type, Authorization, X-API-Key");
});

test("所有 OPTIONS 預檢請求都回傳完整 CORS", async () => {
    const response = await fetchHandler(new Request("https://worker/any-path", { method: "OPTIONS" }), {}, {});
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://player5500-ctrl.github.io");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type, Authorization, X-API-Key");
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

test("LINE Webhook 只使用 /webhook/line", async () => {
    const env = { LINE_CHANNEL_SECRET: "secret" };
    const context = { waitUntil() {} };
    const webhook = await fetchHandler(new Request("https://worker/webhook/line", { method: "POST" }), env, context);
    const oldPath = await fetchHandler(new Request("https://worker/webhooks/line", { method: "POST" }), env, context);
    assert.equal(webhook.status, 401);
    assert.equal(oldPath.status, 404);
});
