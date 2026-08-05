// 一個商品、多個口味／款式：LIFF 客戶端口味選擇畫面驗收。
// liff-order.js 是純瀏覽器 IIFE（依賴 window.location / liff SDK / DOM），
// 沒有現成的 module.exports 可供單元測試呼叫，因此採用與本專案既有慣例一致的
// 原始碼結構驗證（比對 line-note.test.js 對 app.js 的作法），鎖定關鍵契約：
//   - URL 白名單新增 productGroupId，且沒有放寬既有的 userId/token 白名單
//   - 選口味畫面重用既有單一商品下單流程（loadProduct/chooseFlavor），不建立第二套下單邏輯
//   - 售完的口味在畫面上不可點選
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const js = fs.readFileSync(path.join(__dirname, "liff-order.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "liff-order.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "liff-order.css"), "utf8");

test("URL 白名單新增 productGroupId，其餘白名單（groupBuyId/productId/action/quantity）不變", () => {
    const parseQueryFn = js.match(/function parseQuery\(search\)[\s\S]*?\n    }/)[0];
    assert.match(parseQueryFn, /groupBuyId/);
    assert.match(parseQueryFn, /productId/);
    assert.match(parseQueryFn, /productGroupId/);
    assert.match(parseQueryFn, /action/);
    assert.match(parseQueryFn, /quantity/);
    // 絕不放寬讀取 userId / token / 客戶資料（既有安全原則不得被新功能破壞）
    assert.doesNotMatch(parseQueryFn, /userId|idToken|token/i);
});

test("主商品口味資料改走新的 LIFF 群組端點，不重造第二套下單 API", () => {
    assert.match(js, /"\/api\/liff\/group-buys\/"/);
    assert.match(js, /"\/product-groups\/"/);
    // 選好口味後一律呼叫既有的 loadProduct（沿用單一商品下單流程）
    const chooseFlavorFn = js.match(/function chooseFlavor\(productId\)[\s\S]*?\n    }/)[0];
    assert.match(chooseFlavorFn, /loadProduct\(productId\)/);
});

test("口味選擇畫面：售完的口味不可點選，仍會顯示讓客戶知道", () => {
    const renderFlavorPanelFn = js.match(/function renderFlavorPanel\(\)[\s\S]*?\n    }/)[0];
    assert.match(renderFlavorPanelFn, /soldOut/);
    assert.match(renderFlavorPanelFn, /disabled/);
    assert.match(renderFlavorPanelFn, /已售完/);
});

test("render() 會畫出口味選擇區塊，且換口味按鈕會回到口味選擇畫面", () => {
    const renderFn = js.match(/function render\(\)[\s\S]*?\n    }/)[0];
    assert.match(renderFn, /renderFlavorPanel\(\)/);
    assert.match(js, /function backToFlavorPicker\(\)/);
    assert.match(js, /change-flavor-btn.*backToFlavorPicker/s);
});

test("HTML 有口味選擇卡與換口味按鈕，CSS 提供大按鈕與明顯售完樣式（符合手機版要求）", () => {
    assert.match(html, /id="flavor-panel"/);
    assert.match(html, /id="flavor-list"/);
    assert.match(html, /id="change-flavor-btn"/);
    assert.match(css, /\.flavor-item\s*\{/);
    assert.match(css, /\.flavor-item:disabled,\s*\n\.flavor-item\.sold-out/);
    assert.match(css, /min-height:\s*64px/); // 足夠大的點擊區域
});

test("快取版本號已更新，避免客戶瀏覽器沿用舊版口味選擇頁", () => {
    assert.match(html, /liff-order\.css\?v=20260805-flavor-fields/);
    assert.match(html, /liff-order\.js\?v=20260805-flavor-fields/);
});

// 回歸保護：Worker 口味端點回傳 camelCase（productId/variantName/imageUrl），
// 但畫面程式用 snake_case 取值。曾因此造成口味卡沒圖、名稱空白、
// data-flavor-id 空字串 → 點口味後直接顯示「找不到此團購活動」。
test("loadGroup 會把 camelCase 口味欄位轉成畫面用的 snake_case，並丟棄沒有 id 的口味", () => {
    assert.match(js, /function normalizeGroupVariant\(row\)/);
    const normalizeFn = js.match(/function normalizeGroupVariant\(row\)[\s\S]*?\n    }/)[0];
    assert.match(normalizeFn, /row\.productId \|\| row\.id/);
    assert.match(normalizeFn, /row\.variantName \|\| row\.variant_name/);
    assert.match(normalizeFn, /row\.imageUrl \|\| row\.image_url/);
    assert.match(normalizeFn, /row\.pickupPrice/);
    assert.match(normalizeFn, /row\.deliveryPrice/);

    const loadGroupFn = js.match(/function loadGroup\(productGroupId\)[\s\S]*?\n    }/)[0];
    assert.match(loadGroupFn, /\.map\(normalizeGroupVariant\)/);
    assert.match(loadGroupFn, /\.filter\(function \(v\) \{ return v\.id; \}\)/);
});

test("normalizeGroupVariant 實際轉換：camelCase 輸入產出 renderFlavorPanel 需要的欄位", () => {
    // liff-order.js 是瀏覽器 IIFE，這裡抽出 normalizeGroupVariant 單獨執行驗證行為
    const fnSource = js.match(/function normalizeGroupVariant\(row\)[\s\S]*?\n    }/)[0];
    const normalize = new Function("return (" + fnSource.replace(/^function normalizeGroupVariant/, "function") + ")")();
    const out = normalize({
        productId: "P031-A", variantName: "A.6粒", specs: null, unit: "份",
        imageUrl: "https://img.example/a.png", price: 400, pickupPrice: null, deliveryPrice: null,
        stock: { stockEnabled: true, remainingQuantity: 50 }
    });
    assert.equal(out.id, "P031-A");
    assert.equal(out.variant_name, "A.6粒");
    assert.equal(out.image_url, "https://img.example/a.png");
    assert.equal(out.price, 400);
    assert.equal(out.pickup_price, null);
    assert.equal(out.stock.remainingQuantity, 50);
});
