const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFlexMessage, buildGroupFlexMessage, createPostbackData, normalizeQuantities, parsePostbackData } = require("./line-flex.js");

const groupBuy = { id: "GB001", name: "七月團購", ends_at: "2026-07-31T15:59:59.000Z" };
const product = { id: "P001", name: "手工蛋捲", specs: "原味 12 入", price: 180, unit: "盒", image_url: "https://example.com/p1.jpg" };

const LIFF_ID = "2010820387-LPE3k0xA";

function collectButtons(message) {
    const out = [];
    const walk = node => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === "object") {
            if (node.type === "button" && node.action) out.push(node.action);
            Object.values(node).forEach(walk);
        }
    };
    walk(message.contents);
    return out;
}

test("設定 LIFF_ID 時數量按鈕改為 uri action，開 LIFF 下單頁且不含 displayText/price", () => {
    const message = buildFlexMessage({ groupBuy, product, quantities: [1, 2, 3], liffId: LIFF_ID });
    const serialized = JSON.stringify(message);
    // 全卡不得出現 displayText 或 price= 或 token/userId
    assert.doesNotMatch(serialized, /displayText/i);
    assert.doesNotMatch(serialized, /price=/i);
    assert.doesNotMatch(serialized, /idToken|userId=/i);

    const actions = collectButtons(message);
    const quantityActions = actions.filter(a => /^\d+份$/.test(a.label));
    assert.equal(quantityActions.length, 3, "應有三顆數量按鈕");
    for (const a of quantityActions) {
        assert.equal(a.type, "uri", "數量按鈕須為 uri action");
        assert.equal("displayText" in a, false, "uri action 不得含 displayText");
        assert.match(a.uri, /^https:\/\/liff\.line\.me\//);
        assert.match(a.uri, new RegExp(`liff\\.line\\.me/${LIFF_ID}`));
        assert.match(a.uri, /groupBuyId=GB001/);
        assert.match(a.uri, /productId=P001/);
        assert.match(a.uri, /quantity=\d+/);
        assert.doesNotMatch(a.uri, /price=/i);
    }
    // quantity=3 的按鈕確實存在
    assert.ok(quantityActions.some(a => /quantity=3/.test(a.uri)), "應有 quantity=3 的 uri");
    // 立即訂購（quantity=1）、查看／修改我的訂單、取消訂購 皆為 uri，且 cancel/myorder 走 action=myorder
    const buy = actions.find(a => a.label === "立即訂購");
    assert.equal(buy.type, "uri");
    assert.match(buy.uri, /quantity=1/);
    const view = actions.find(a => a.label === "查看／修改我的訂單");
    assert.equal(view.type, "uri");
    assert.match(view.uri, /action=myorder/);
    const cancel = actions.find(a => a.label === "取消訂購");
    assert.equal(cancel.type, "uri");
    assert.match(cancel.uri, /action=myorder/);
});

test("未提供 LIFF_ID 時回退既有 Postback 按鈕（設定前不中斷）", () => {
    assert.equal(createPostbackData("set_quantity", "GB001", "P001", 1), "action=set_quantity&groupBuyId=GB001&productId=P001&quantity=1");
    const message = buildFlexMessage({ groupBuy, product, quantities: [1, 2, 3] });
    const serialized = JSON.stringify(message);
    assert.doesNotMatch(serialized, /displayText|price=/i);
    assert.doesNotMatch(serialized, /liff\.line\.me/);
    assert.match(serialized, /action=set_quantity&groupBuyId=GB001&productId=P001&quantity=3/);
    assert.match(serialized, /action=cancel_item&groupBuyId=GB001&productId=P001/);
    // 查看我的訂單（view_order）按鈕仍不重建
    assert.doesNotMatch(serialized, /action=view_order/);
    const actions = collectButtons(message);
    assert.ok(actions.filter(a => /^\d+份$/.test(a.label)).every(a => a.type === "postback"), "回退時數量按鈕須為 postback");
});

test("Flex 商品卡顯示圖片、名稱、規格、售價、單位、截止時間與數量／取消按鈕", () => {
    const message = buildFlexMessage({ groupBuy, product, showImage: true, quantities: [1, 2, 3], liffId: LIFF_ID });
    assert.equal(message.type, "flex");
    assert.equal(message.contents.hero.url, product.image_url);
    const serialized = JSON.stringify(message);
    for (const value of [product.name, product.specs, "NT$ 180", "/ 盒", "收單截止", "1份", "2份", "3份", "取消訂購"]) {
        assert.equal(serialized.includes(value), true, `商品卡應包含：${value}`);
    }
});

test("新商品卡可顯示本團固定限量與售完為止，不寫死即時剩餘數量", () => {
    const message = buildFlexMessage({
        groupBuy: { id: "GB1", name: "測試團", ends_at: "2099-12-31T00:00:00Z" },
        product: {
            id: "P1", name: "Pril檸檬", specs: "653ml×3瓶", unit: "組", price: 180,
            stock_enabled: true, sellable_quantity: 30, remaining_quantity: 7
        }
    });
    const text = JSON.stringify(message);
    assert.match(text, /限量 30 組｜售完為止/);
    assert.doesNotMatch(text, /剩餘 7/);
});

test("數量組合會去重、限制一到三顆合法按鈕", () => {
    assert.deepEqual(normalizeQuantities([3, 1, 3, 0, 100, 2, 4]), [3, 1, 2]);
    assert.throws(() => buildFlexMessage({ groupBuy, product, quantities: [] }), /至少選擇一個數量按鈕/);
});

test("一個商品、多個口味：合併成一張主商品卡，只有一顆按鈕開 LIFF 帶 productGroupId", () => {
    const productGroup = { id: "PG024", name: "德國 Pril 洗碗精", image_url: "https://example.com/pril.jpg" };
    const variants = [
        { id: "P024-A", name: "德國 Pril 洗碗精 檨檬", variant_name: "檨檬", price: 210, pickup_price: 210, delivery_price: 225 },
        { id: "P024-B", name: "德國 Pril 洗碗精 蘆薈", variant_name: "蘆薈", price: 220, pickup_price: 220, delivery_price: 235 }
    ];
    const message = buildGroupFlexMessage({ groupBuy, productGroup, variants, liffId: LIFF_ID });
    const serialized = JSON.stringify(message);

    // 不得使用 displayText／價格藏在 postback／liff.line.me 以外的下單文字
    assert.doesNotMatch(serialized, /displayText/i);
    assert.doesNotMatch(serialized, /"price=/i);
    assert.match(serialized, /共有 2 種口味：檨檬／蘆薈/);
    assert.match(serialized, /自取 NT\$ 210 起/);
    assert.match(serialized, /外送 NT\$ 225 起/);

    const actions = collectButtons(message);
    assert.equal(actions.length, 1, "合併卡只應有一顆按鈕");
    const [button] = actions;
    assert.equal(button.label, "選擇口味與數量");
    assert.equal(button.type, "uri");
    assert.match(button.uri, new RegExp(`liff\\.line\\.me/${LIFF_ID}`));
    assert.match(button.uri, /groupBuyId=GB001/);
    assert.match(button.uri, /productGroupId=PG024/);
    assert.doesNotMatch(button.uri, /[?&]productId=/);
});

test("合併商品卡封面圖：主商品有圖用主商品圖；主商品沒圖時退回第一個有圖的口味；都沒圖就不放 hero", () => {
    const variants = [
        { id: "P024-A", variant_name: "檨檬", price: 210, image_url: "https://example.com/a.jpg" },
        { id: "P024-B", variant_name: "蘆薈", price: 220, image_url: "https://example.com/b.jpg" }
    ];
    const withGroupImage = buildGroupFlexMessage({
        groupBuy, productGroup: { id: "PG024", name: "德國 Pril 洗碗精", image_url: "https://example.com/pril.jpg" },
        variants, liffId: LIFF_ID
    });
    assert.equal(withGroupImage.contents.hero.url, "https://example.com/pril.jpg");

    const fallbackToVariant = buildGroupFlexMessage({
        groupBuy, productGroup: { id: "PG024", name: "德國 Pril 洗碗精", image_url: null },
        variants, liffId: LIFF_ID
    });
    assert.equal(fallbackToVariant.contents.hero.url, "https://example.com/a.jpg", "主商品沒圖時應退回第一個有圖的口味");

    const noImage = buildGroupFlexMessage({
        groupBuy, productGroup: { id: "PG024", name: "德國 Pril 洗碗精", image_url: null },
        variants: variants.map(v => ({ ...v, image_url: null })), liffId: LIFF_ID
    });
    assert.equal(noImage.contents.hero, undefined);
});

test("合併商品卡缺少 LIFF_ID 或沒有可發布的口味時要丟出明確錯誤", () => {
    const productGroup = { id: "PG024", name: "德國 Pril 洗碗精" };
    const variants = [{ id: "P024-A", variant_name: "檨檬", price: 210 }];
    assert.throws(() => buildGroupFlexMessage({ groupBuy, productGroup, variants }), /LIFF_ID/);
    assert.throws(() => buildGroupFlexMessage({ groupBuy, productGroup, variants: [], liffId: LIFF_ID }), /沒有可發布的口味/);
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
