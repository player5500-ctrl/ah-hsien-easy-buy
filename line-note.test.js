const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const LineNote = require("./line-note.js");

const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const products = [
    { id: "P001", name: "高麗菜水餃", specs: "20顆", price: 120, unit: "包", description: "冷凍保存", enabled: true, photo: "https://img.example/p001.png" },
    { id: "P002", name: "手工蛋捲", specs: "12入", price: 260, unit: "盒", description: "原味", enabled: true, photo: "https://img.example/p002.png" },
    { id: "P003", name: "停用品", specs: "", price: 10, unit: "個", enabled: false, photo: "" }
];

test("有兩個啟用商品時，選擇 P001 的文案不包含 P002", () => {
    const note = LineNote.generateLineNote(products, { productId: "P001" });
    assert.match(note, /【P001】高麗菜水餃（20顆）/);
    assert.match(note, /NT\$120／包/);
    assert.match(note, /ℹ️ 冷凍保存/);
    assert.match(note, /🖼 https:\/\/img\.example\/p001\.png/);
    assert.doesNotMatch(note, /P002|手工蛋捲/);
    assert.match(note, /例如「P001\+5」/);
    assert.match(note, /更正 P001\+3/);
    assert.match(note, /取消 P001/);
    assert.match(note, /只有一樣商品，直接留言「\+2」也可以/);
    assert.match(note, /以最後一次按的為準（不會累加）/);
    assert.match(note, /按了卡片不會有任何回應是正常的/);
});

test("切換成 P002 時，文案及下單、更正、取消範例全部切換", () => {
    const note = LineNote.generateLineNote(products, { productId: "P002" });
    assert.match(note, /【P002】手工蛋捲（12入）/);
    assert.match(note, /NT\$260／盒/);
    assert.match(note, /ℹ️ 原味/);
    assert.match(note, /🖼 https:\/\/img\.example\/p002\.png/);
    assert.doesNotMatch(note, /P001|高麗菜水餃/);
    assert.match(note, /只有一樣商品，直接留言「\+2」也可以/);
    assert.match(note, /例如「P002\+5」/);
    assert.match(note, /更正 P002\+3/);
    assert.match(note, /取消 P002/);
});

test("停用商品不出現在可選商品，選項格式包含代碼、名稱及規格", () => {
    const enabled = LineNote.enabledProducts(products);
    assert.deepEqual(enabled.map(product => product.id), ["P001", "P002"]);
    assert.equal(LineNote.productOptionLabel(enabled[0]), "P001｜高麗菜水餃（20顆）");
    assert.equal(LineNote.productOptionLabel(enabled[1]), "P002｜手工蛋捲（12入）");
});

test("沒有啟用商品時回傳空字串", () => {
    assert.equal(LineNote.generateLineNote([products[2]]), "");
    assert.equal(LineNote.generateLineNote([]), "");
});

test("帶入團購資訊時包含截止時間、到貨與自取外送說明", () => {
    const note = LineNote.generateLineNote(products, {
        productId: "P001",
        title: "阿賢Easy購｜[TEST] LINE 靜默收單驗收",
        deadline: "2026-07-25",
        arrival: "7/28 到貨",
        pickupInfo: "自取 NT$250／外送 NT$260",
        notes: "冷藏保存，可保存7天"
    });
    assert.match(note, /\[TEST\] LINE 靜默收單驗收/);
    assert.match(note, /⏰ 收單截止：2026-07-25 23:59/);
    assert.match(note, /🚚 到貨／發貨：7\/28 到貨/);
    assert.match(note, /🏠 自取／外送：自取 NT\$250／外送 NT\$260/);
    assert.match(note, /📌 冷藏保存，可保存7天/);
});

test("文案包含商品卡按鈕下單教學且不會輸出 undefined/null", () => {
    const note = LineNote.generateLineNote(products, { productId: "P001" });
    assert.match(note, /請直接點選群組中的商品訂購卡選擇數量/);
    assert.match(note, /不用在聊天室留言＋1/);
    assert.doesNotMatch(note, /undefined|null/);
});

test("下載圖片只回傳目前選取商品", () => {
    const selected = LineNote.selectedProductImage(products, "P002");
    assert.equal(selected.product.id, "P002");
    assert.equal(selected.url, "https://img.example/p002.png");
    assert.doesNotMatch(selected.url, /p001/);
});

test("沒有啟用商品時不提供預設選取商品或圖片", () => {
    assert.equal(LineNote.selectedProduct([products[2]], ""), null);
    assert.equal(LineNote.selectedProductImage([products[2]], "P003"), null);
});

test("記事本文案視窗只列本團啟用商品，且沒有商品時不開啟空白視窗", () => {
    const openStart = appSource.indexOf("function openLineNoteModal()");
    const closeStart = appSource.indexOf("function closeLineNoteModal()", openStart);
    const source = appSource.slice(openStart, closeStart);
    const emptyGuard = source.indexOf("if (!lineNoteProducts.length)");
    const openModal = source.indexOf("classList.add('show')");

    assert.match(source, /LineNote\.enabledProducts\(groupBuyLineNoteProducts\(groupBuy\)\)/);
    assert.match(source, /目前沒有啟用中的商品，請先啟用商品再產生文案！/);
    assert.ok(emptyGuard >= 0 && openModal > emptyGuard);
    assert.match(source, /select\.value = lineNoteProducts\[0\]\.id/);
});

test("記事本文案商品來源有勾選代碼時只保留本團商品", () => {
    const selected = LineNote.groupProducts(products, ["P002"]);
    assert.deepEqual(selected.map(product => product.id), ["P002"]);

    const filterStart = appSource.indexOf("function groupBuyLineNoteProducts(groupBuy)");
    const openStart = appSource.indexOf("function openLineNoteModal()", filterStart);
    const source = appSource.slice(filterStart, openStart);

    assert.match(source, /LineNote\.groupProducts\(state\.products, groupBuy\.productIds\)/);
});

test("舊團購沒有 productIds 時沿用啟用中商品，不再錯誤顯示無商品", () => {
    const legacyProducts = LineNote.groupProducts(products, []);
    const enabled = LineNote.enabledProducts(legacyProducts);

    assert.deepEqual(enabled.map(product => product.id), ["P001", "P002"]);
    assert.doesNotMatch(LineNote.generateLineNote(enabled, { productId: "P001" }), /P002/);
});

test("下拉選單切換立即更新單商品預覽，一鍵複製只讀取目前預覽", () => {
    assert.match(htmlSource, /選擇要產生文案的商品/);
    assert.match(htmlSource, /id="line-note-product-select" onchange="updateLineNotePreview\(\)"/);
    assert.match(appSource, /LineNote\.generateLineNote\(lineNoteProducts, lineNoteOptions\(groupBuy, product\.id\)\)/);
    assert.match(appSource, /document\.getElementById\('line-note-textarea'\)\.value/);
});

test("下載按鈕只處理目前選取商品，不再巡覽全部啟用商品", () => {
    const downloadStart = appSource.indexOf("async function downloadLineNoteImages()");
    const copyStart = appSource.indexOf("async function copyLineNote()", downloadStart);
    const source = appSource.slice(downloadStart, copyStart);

    assert.match(htmlSource, /下載所選商品圖/);
    assert.match(source, /LineNote\.selectedProductImage\(lineNoteProducts, selectedId\)/);
    assert.doesNotMatch(source, /groupBuyProducts|for\s*\(/);
});
