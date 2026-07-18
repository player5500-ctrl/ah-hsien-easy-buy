const test = require("node:test");
const assert = require("node:assert/strict");
const { verifySignature, handleWebhook } = require("./webhook-handler.js");

async function sign(body, secret) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function event(text = "A1", overrides = {}) {
    return { type: "message", timestamp: Date.parse("2026-07-18T10:00:00Z"), source: { type: "group", groupId: "G1", userId: "U1" }, message: { id: "M1", type: "text", text }, ...overrides };
}

function dependencies(options = {}) {
    const inserted = [];
    return {
        inserted,
        hasMessage: async () => Boolean(options.exists),
        getDisplayName: async () => "王小明",
        getProductCodes: async () => ["A"],
        findCustomer: async () => options.customer === false ? null : ({ id: "A001", nickname: "小明", pickupType: "自取" }),
        isSuspectedDuplicate: async () => false,
        insertInbox: async value => inserted.push(value)
    };
}

test("Webhook 簽章驗證", async () => {
    const signature = await sign("hello", "secret");
    assert.equal(await verifySignature("hello", signature, "secret"), true);
    assert.equal(await verifySignature("changed", signature, "secret"), false);
});

test("Webhook 快速回傳 200 並在 waitUntil 背景寫入；不產生任何回覆", async () => {
    const body = JSON.stringify({ events: [event()] });
    const deps = dependencies();
    let background;
    const request = new Request("https://example.com/webhooks/line", { method: "POST", body, headers: { "x-line-signature": await sign(body, "secret") } });
    const response = await handleWebhook(request, { LINE_CHANNEL_SECRET: "secret" }, { waitUntil(value) { background = value; } }, deps);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "OK");
    await background;
    assert.equal(deps.inserted.length, 1);
    assert.equal(deps.inserted[0].status, "已解析");
});

test("相同 messageId 重送不重複寫入", async () => {
    const body = JSON.stringify({ events: [event()] });
    const deps = dependencies({ exists: true });
    let background;
    const request = new Request("https://example.com/webhooks/line", { method: "POST", body, headers: { "x-line-signature": await sign(body, "secret") } });
    await handleWebhook(request, { LINE_CHANNEL_SECRET: "secret" }, { waitUntil(value) { background = value; } }, deps);
    await background;
    assert.equal(deps.inserted.length, 0);
});

test("多人聊天室 room 事件也能靜默寫入", async () => {
    const roomEvent = event("A1", { source: { type: "room", roomId: "R1", userId: "U1" } });
    const body = JSON.stringify({ events: [roomEvent] });
    const deps = dependencies();
    let background;
    const request = new Request("https://example.com/webhooks/line", { method: "POST", body, headers: { "x-line-signature": await sign(body, "secret") } });
    const response = await handleWebhook(request, { LINE_CHANNEL_SECRET: "secret" }, { waitUntil(value) { background = value; } }, deps);
    await background;
    assert.equal(response.status, 200);
    assert.equal(deps.inserted.length, 1);
    assert.equal(deps.inserted[0].groupId, "R1");
});

test("新 LINE userId 標示待綁定；格式錯誤只寫後台", async () => {
    for (const [text, expected, options] of [["A1", "待綁定", { customer: false }], ["+2", "待確認", {}]]) {
        const body = JSON.stringify({ events: [event(text)] });
        const deps = dependencies(options);
        let background;
        const request = new Request("https://example.com/webhooks/line", { method: "POST", body, headers: { "x-line-signature": await sign(body, "secret") } });
        const response = await handleWebhook(request, { LINE_CHANNEL_SECRET: "secret" }, { waitUntil(value) { background = value; } }, deps);
        await background;
        assert.equal(response.status, 200);
        assert.equal(deps.inserted[0].status, expected);
    }
});

test("程式不包含 LINE 訊息發送端點", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(require.resolve("./index.js"), "utf8") + fs.readFileSync(require.resolve("./webhook-handler.js"), "utf8");
    assert.doesNotMatch(source, /\/v2\/bot\/message\/(reply|push|broadcast|multicast|narrowcast)/i);
});
