// 截圖匯入解析器測試：node --test chat-import.test.js
const test = require("node:test");
const assert = require("node:assert");
const ChatImport = require("./chat-import.js");

const KUAI_KUAI_SAMPLE = [
    "#7月22日結單",
    "#統一",
    "【乖乖】好運箱/開運箱 $120",
    "外送 +15",
    "A.【乖乖好運箱-椰子】",
    "B.【乖乖開運箱-五香】",
    "… 顯示更多",
    "昨天 下午 3:18",
    "佩芳",
    "B+1",
    "昨天 下午 3:20",
    "馮淑真",
    "A+1",
    "B+1"
].join("\n");

test("乖乖案例：品項、價格、外送費", function () {
    const r = ChatImport.parseChatText(KUAI_KUAI_SAMPLE);
    assert.strictEqual(r.options.length, 2);
    assert.strictEqual(r.options[0].key, "A");
    assert.strictEqual(r.options[0].name, "乖乖好運箱-椰子");
    assert.strictEqual(r.options[0].price, 120); // 無標價 → 回填基準價
    assert.strictEqual(r.options[1].key, "B");
    assert.strictEqual(r.options[1].name, "乖乖開運箱-五香");
    assert.strictEqual(r.basePrice, 120);
    assert.strictEqual(r.deliveryFee, 15);
});

test("乖乖案例：兩位訂購人與數量", function () {
    const r = ChatImport.parseChatText(KUAI_KUAI_SAMPLE);
    assert.strictEqual(r.orders.length, 2);
    const pei = r.orders.find(function (o) { return o.nickname === "佩芳"; });
    assert.ok(pei);
    assert.deepStrictEqual(pei.items, [{ key: "B", qty: 1 }]);
    const feng = r.orders.find(function (o) { return o.nickname === "馮淑真"; });
    assert.ok(feng);
    assert.deepStrictEqual(feng.items, [{ key: "A", qty: 1 }, { key: "B", qty: 1 }]);
});

test("同一人同品項重複回覆會累加", function () {
    const r = ChatImport.parseChatText("A.【蛋捲】$100\n小美\nA+1\nA+2");
    assert.deepStrictEqual(r.orders[0].items, [{ key: "A", qty: 3 }]);
});

test("同行多 token：A+1 B+2", function () {
    const r = ChatImport.parseChatText("A.【蛋捲】$100\nB.【紅茶】$60\n小華\nA+1 B+2");
    assert.deepStrictEqual(r.orders[0].items, [{ key: "A", qty: 1 }, { key: "B", qty: 2 }]);
});

test("單品貼文的純 +1 直接歸到唯一品項", function () {
    const r = ChatImport.parseChatText("【手工蛋捲】一盒 $180\n阿玉\n+1\n下午 2:00\n春嬌\n+2");
    assert.strictEqual(r.options.length, 1);
    assert.strictEqual(r.options[0].price, 180);
    assert.strictEqual(r.orders.length, 2);
    assert.deepStrictEqual(r.orders[0].items, [{ key: "A", qty: 1 }]);
    assert.deepStrictEqual(r.orders[1].items, [{ key: "A", qty: 2 }]);
});

test("多品項貼文的純 +1 標成 ? 並出警告", function () {
    const r = ChatImport.parseChatText("A.【蛋捲】$100\nB.【紅茶】$60\n阿明\n+1");
    assert.deepStrictEqual(r.orders[0].items, [{ key: "?", qty: 1 }]);
    assert.ok(r.warnings.some(function (w) { return w.indexOf("阿明") > -1; }));
});

test("時間戳會切斷訂購人歸屬", function () {
    const r = ChatImport.parseChatText("A.【蛋捲】$100\n小美\n下午 3:00\nB+1");
    // 小美後面接時間戳，B+1 找不到訂購人 → 略過＋警告
    assert.strictEqual(r.orders.length, 0);
    assert.ok(r.warnings.length > 0);
});

test("沒有價格時填 0 並警告", function () {
    const r = ChatImport.parseChatText("A.【神秘商品】\n小趙\nA+1");
    assert.strictEqual(r.options[0].price, 0);
    assert.ok(r.warnings.some(function (w) { return w.indexOf("價格") > -1; }));
});

test("暱稱去 emoji", function () {
    const r = ChatImport.parseChatText("A.【蛋捲】$100\n小咪🐱\nA+1");
    assert.strictEqual(r.orders[0].nickname, "小咪");
});

test("normalizeOcrText 收斂中文字間空白、保留 A+1", function () {
    const out = ChatImport.normalizeOcrText("佩 芳\nB+1");
    assert.strictEqual(out, "佩芳\nB+1");
});
