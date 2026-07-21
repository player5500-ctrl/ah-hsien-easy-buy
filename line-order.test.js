const test = require("node:test");
const assert = require("node:assert/strict");
const LineOrder = require("./line-order.js");

const catalog = ["P023-A", "P023-B", "A"];

test("解析記事本商品代碼與多口味數量", () => {
    assert.deepEqual(LineOrder.parseMessage("P023 A+3 B+1", catalog), {
        normalized: "P023 A+3 B+1",
        items: [
            { productCode: "P023-A", quantity: 3 },
            { productCode: "P023-B", quantity: 1 }
        ],
        status: LineOrder.STATUS.READY,
        errorReason: "",
        action: "create",
        targetProductPrefix: "P023"
    });
});

test("相容完整商品碼、舊格式及全形符號", () => {
    assert.deepEqual(LineOrder.parseMessage("P023-A+2", catalog).items, [{ productCode: "P023-A", quantity: 2 }]);
    assert.deepEqual(LineOrder.parseMessage("A1", catalog).items, [{ productCode: "A", quantity: 1 }]);
    assert.equal(LineOrder.normalizeMessage("ｐ０２３　ａ＋２"), "P023 A+2");
});

test("解析更正與取消命令", () => {
    const correction = LineOrder.parseMessage("更正 P023 A+2", catalog);
    assert.equal(correction.action, "replace");
    assert.equal(correction.targetProductPrefix, "P023");
    assert.deepEqual(correction.items, [{ productCode: "P023-A", quantity: 2 }]);

    const cancellation = LineOrder.parseMessage("取消 P023", catalog);
    assert.equal(cancellation.action, "cancel");
    assert.equal(cancellation.status, LineOrder.STATUS.READY);
    assert.equal(cancellation.targetProductPrefix, "P023");
});

test("拒絕未知商品、未知口味與缺少商品碼", () => {
    assert.equal(LineOrder.parseMessage("P999 A+2", catalog).status, LineOrder.STATUS.UNKNOWN_PRODUCT);
    assert.equal(LineOrder.parseMessage("P023 C+2", catalog).status, LineOrder.STATUS.UNKNOWN_PRODUCT);
    assert.equal(LineOrder.parseMessage("+2", catalog).status, LineOrder.STATUS.INCOMPLETE);
});

test("單一商品啟用時 +N 自動對應", () => {
    const single = ["P05"];
    assert.deepEqual(LineOrder.parseMessage("+4", single), {
        normalized: "+4",
        items: [{ productCode: "P05", quantity: 4 }],
        status: LineOrder.STATUS.READY,
        errorReason: "",
        action: "create",
        targetProductPrefix: "P05"
    });
    assert.deepEqual(LineOrder.parseMessage("X3", single).items, [{ productCode: "P05", quantity: 3 }]);
    assert.deepEqual(LineOrder.parseMessage("＋２", single).items, [{ productCode: "P05", quantity: 2 }]);
});

test("多商品啟用時 +N 維持格式不完整並提示範例", () => {
    const parsed = LineOrder.parseMessage("+2", catalog);
    assert.equal(parsed.status, LineOrder.STATUS.INCOMPLETE);
    assert.match(parsed.errorReason, /請註明商品代碼/);
});

test("複合寫法 +1+2 不自動對應", () => {
    assert.equal(LineOrder.parseMessage("+1+2", ["P05"]).status, LineOrder.STATUS.INCOMPLETE);
    assert.equal(LineOrder.parseMessage("+1000", ["P05"]).status, LineOrder.STATUS.INCOMPLETE);
});

test("五分鐘內相同訊息標示為疑似重複", () => {
    const current = { messageId: "2", groupId: "G", lineUserId: "U", normalizedMessage: "P023 A+1", messageTime: "2026-07-18T10:03:00Z" };
    const existing = [{ ...current, messageId: "1", messageTime: "2026-07-18T10:00:00Z" }];
    assert.equal(LineOrder.isSuspectedDuplicate(current, existing), true);
});
