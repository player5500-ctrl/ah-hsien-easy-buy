const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFlexMessage, createPostbackData, normalizeQuantities, parsePostbackData } = require("./line-flex.js");

const groupBuy = { id: "GB001", name: "七月團購", ends_at: "2026-07-31T15:59:59.000Z" };
const product = { id: "P001", name: "手工蛋捲", specs: "原味 12 入", price: 180, unit: "盒", image_url: "https://example.com/p1.jpg" };

test("Postback 格式只含識別碼與數量，不含價格或 displayText", () => {
    assert.equal(createPostbackData("set_quantity", "GB001", "P001", 1), "action=set_quantity&groupBuyId=GB001&productId=P001&quantity=1");
    const message = buildFlexMessage({ groupBuy, product, quantities: [1, 2, 3] });
    const serialized = JSON.stringify(message);
    assert.doesNotMatch(serialized, /displayText|price=/i);
    assert.match(serialized, /action=set_quantity&groupBuyId=GB001&productId=P001&quantity=3/);
    assert.match(serialized, /action=cancel_item&groupBuyId=GB001&productId=P001/);
    // 查看我的訂單（view_order）按鈕已移除：靜默 Postback 對客戶沒有可見回饋
    assert.doesNotMatch(serialized, /action=view_order/);
});

test("Flex 商品卡顯示圖片、名稱、規格、售價、單位、截止時間與四種按鈕", () => {
    const message = buildFlexMessage({ groupBuy, product, showImage: true, quantities: [1, 2, 3] });
    assert.equal(message.type, "flex");
    assert.equal(message.contents.hero.url, product.image_url);
    const serialized = JSON.stringify(message);
    for (const value of [product.name, product.specs, "NT$ 180", "/ 盒", "收單截止", "1份", "2份", "3份", "取消訂購"]) {
        assert.equal(serialized.includes(value), true, `商品卡應包含：${value}`);
    }
    assert.equal(serialized.includes("查看我的訂單"), false, "查看我的訂單按鈕應已移除");
});

test("數量組合會去重、限制一到三顆合法按鈕", () => {
    assert.deepEqual(normalizeQuantities([3, 1, 3, 0, 100, 2, 4]), [3, 1, 2]);
    assert.throws(() => buildFlexMessage({ groupBuy, product, quantities: [] }), /至少選擇一個數量按鈕/);
});

test("解析設定、取消與查看訂單；拒絕價格與非法數量", () => {
    assert.deepEqual(parsePostbackData("action=set_quantity&groupBuyId=GB001&productId=P001&quantity=3"), {
        action: "set_quantity", groupBuyId: "GB001", productId: "P001", quantity: 3
    });
    assert.equal(parsePostbackData("action=cancel_item&groupBuyId=GB001&productId=P001").quantity, 0);
    assert.equal(parsePostbackData("action=view_order&groupBuyId=GB001&productId=P001").action, "view_order");
    assert.match(parsePostbackData("action=set_quantity&groupBuyId=GB001&productId=P001&quantity=1&price=10").error, /價格/);
    assert.match(parsePostbackData("action=set_quantity&groupBuyId=GB001&productId=P001&quantity=0").error, /數量/);
});
