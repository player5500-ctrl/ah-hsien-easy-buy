const test = require("node:test");
const assert = require("node:assert/strict");
const LineOrder = require("./line-order.js");

test("A1 解析為 A 商品 1 組", () => {
    assert.deepEqual(LineOrder.parseMessage("A1", ["A"]), {
        normalized: "A1", items: [{ productCode: "A", quantity: 1 }], status: "已解析", errorReason: ""
    });
});

test("全形小寫與全形加號會標準化並解析", () => {
    assert.deepEqual(LineOrder.parseMessage("ａ＋２", ["A"]).items, [{ productCode: "A", quantity: 2 }]);
    assert.equal(LineOrder.normalizeMessage("ａ＋２"), "A+2");
});

test("只有數量視為待確認；不存在商品視為格式錯誤", () => {
    assert.equal(LineOrder.parseMessage("+2", ["A"]).status, "待確認");
    assert.equal(LineOrder.parseMessage("Z+2", ["A"]).status, "格式錯誤");
});

test("五分鐘內相同客戶與內容標示為疑似重複", () => {
    const current = { messageId: "2", groupId: "G", lineUserId: "U", normalizedMessage: "A1", messageTime: "2026-07-18T10:03:00Z" };
    const existing = [{ ...current, messageId: "1", messageTime: "2026-07-18T10:00:00Z" }];
    assert.equal(LineOrder.isSuspectedDuplicate(current, existing), true);
});
