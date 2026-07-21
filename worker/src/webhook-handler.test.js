const test = require("node:test");
const assert = require("node:assert/strict");
const LineOrder = require("../../line-order.js");
const { verifySignature, handleWebhook } = require("./webhook-handler.js");

async function sign(body, secret) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function event(text = "P023 A+1", overrides = {}) {
    return { type: "message", webhookEventId: "W1", timestamp: Date.parse("2026-07-18T10:00:00Z"), source: { type: "group", groupId: "G1", userId: "U1" }, message: { id: "M1", type: "text", text }, ...overrides };
}

function dependencies(options = {}) {
    const inserted = [];
    const unsent = [];
    return {
        inserted,
        unsent,
        hasMessage: async () => Boolean(options.exists),
        getDisplayName: async () => "Vanny(宛荃)",
        getProductCodes: async () => ["P023-A", "P023-B"],
        findCustomer: async () => options.customer === false ? null : ({ id: "A001", nickname: "Vanny", pickupType: "自取" }),
        isSuspectedDuplicate: async () => false,
        insertInbox: async value => inserted.push(value),
        markUnsent: async (messageId, time) => unsent.push({ messageId, time })
    };
}

test("驗證 LINE Webhook 簽章", async () => {
    const signature = await sign("hello", "secret");
    assert.equal(await verifySignature("hello", signature, "secret"), true);
    assert.equal(await verifySignature("changed", signature, "secret"), false);
});

test("Webhook 立即回覆 200 並在背景寫入收件匣", async () => {
    const body = JSON.stringify({ events: [event()] });
    const deps = dependencies();
    let background;
    const request = new Request("https://example.com/webhook/line", { method: "POST", body, headers: { "x-line-signature": await sign(body, "secret") } });
    const response = await handleWebhook(request, { LINE_CHANNEL_SECRET: "secret" }, { waitUntil(value) { background = value; } }, deps);
    assert.equal(response.status, 200);
    await background;
    assert.equal(deps.inserted[0].status, LineOrder.STATUS.READY);
    assert.deepEqual(deps.inserted[0].parsedItems, [{ productCode: "P023-A", quantity: 1 }]);
});

test("相同 messageId 或 webhookEventId 不重複寫入", async () => {
    const body = JSON.stringify({ events: [event()] });
    const deps = dependencies({ exists: true });
    let background;
    const request = new Request("https://example.com/webhook/line", { method: "POST", body, headers: { "x-line-signature": await sign(body, "secret") } });
    await handleWebhook(request, { LINE_CHANNEL_SECRET: "secret" }, { waitUntil(value) { background = value; } }, deps);
    await background;
    assert.equal(deps.inserted.length, 0);
});

test("未配對客戶保持在待配對狀態", async () => {
    const body = JSON.stringify({ events: [event()] });
    const deps = dependencies({ customer: false });
    let background;
    const request = new Request("https://example.com/webhook/line", { method: "POST", body, headers: { "x-line-signature": await sign(body, "secret") } });
    await handleWebhook(request, { LINE_CHANNEL_SECRET: "secret" }, { waitUntil(value) { background = value; } }, deps);
    await background;
    assert.equal(deps.inserted[0].status, LineOrder.STATUS.CUSTOMER_UNMATCHED);
});

test("LINE 收回事件標記原始收件紀錄", async () => {
    const unsend = { type: "unsend", webhookEventId: "W2", timestamp: Date.now(), source: { type: "group", groupId: "G1", userId: "U1" }, unsend: { messageId: "M1" } };
    const body = JSON.stringify({ events: [unsend] });
    const deps = dependencies();
    let background;
    const request = new Request("https://example.com/webhook/line", { method: "POST", body, headers: { "x-line-signature": await sign(body, "secret") } });
    await handleWebhook(request, { LINE_CHANNEL_SECRET: "secret" }, { waitUntil(value) { background = value; } }, deps);
    await background;
    assert.equal(deps.unsent[0].messageId, "M1");
});

test("完全靜默：程式沒有呼叫任何 LINE 發訊端點", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(require.resolve("./index.js"), "utf8") + fs.readFileSync(require.resolve("./webhook-handler.js"), "utf8");
    assert.doesNotMatch(source, /\/v2\/bot\/message\/(reply|push|broadcast|multicast|narrowcast)/i);
});
