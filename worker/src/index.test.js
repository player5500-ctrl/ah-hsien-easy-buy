const test = require("node:test");
const assert = require("node:assert/strict");
const { corsHeaders, isAdmin } = require("./index.js");

test("管理 API 必須使用 Bearer 金鑰", () => {
    const env = { ADMIN_API_KEY: "secret" };
    assert.equal(isAdmin(new Request("https://worker/api/line-inbox", { headers: { authorization: "Bearer secret" } }), env), true);
    assert.equal(isAdmin(new Request("https://worker/api/line-inbox"), env), false);
});

test("CORS 只允許指定的管理網站", () => {
    const env = { ADMIN_ORIGIN: "https://player5500-ctrl.github.io" };
    const allowed = corsHeaders(new Request("https://worker/api/line-inbox", { headers: { origin: env.ADMIN_ORIGIN } }), env);
    const denied = corsHeaders(new Request("https://worker/api/line-inbox", { headers: { origin: "https://example.com" } }), env);
    assert.equal(allowed["access-control-allow-origin"], env.ADMIN_ORIGIN);
    assert.deepEqual(denied, {});
});
