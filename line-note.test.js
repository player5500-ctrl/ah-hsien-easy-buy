const test = require("node:test");
const assert = require("node:assert/strict");
const LineNote = require("./line-note.js");

const products = [
    { id: "P001", name: "高麗菜水餃", specs: "20顆", price: 120, unit: "包", enabled: true, photo: "https://img.example/p001.png" },
    { id: "P002", name: "布丁", specs: "", price: 60.4, unit: "個", enabled: true, photo: "" },
    { id: "P003", name: "停用品", specs: "", price: 10, unit: "個", enabled: false, photo: "" }
];

test("產生文案：只含啟用商品、含圖片連結與下單教學", () => {
    const note = LineNote.generateLineNote(products);
    assert.match(note, /【P001】高麗菜水餃（20顆）/);
    assert.match(note, /NT\$120／包/);
    assert.match(note, /🖼 https:\/\/img\.example\/p001\.png/);
    assert.match(note, /NT\$60／個/);
    assert.doesNotMatch(note, /停用品/);
    assert.match(note, /例如「P001\+5」/);
    assert.match(note, /以最後一次按的為準（不會累加）/);
    assert.match(note, /按了卡片不會有任何回應是正常的/);
    assert.doesNotMatch(note, /直接留言「\+2」/);
});

test("單一商品時加入 +N 快速下單說明", () => {
    const note = LineNote.generateLineNote([products[1]]);
    assert.match(note, /只有一樣商品，直接留言「\+2」也可以/);
    assert.match(note, /例如「P002\+5」/);
});

test("沒有啟用商品時回傳空字串", () => {
    assert.equal(LineNote.generateLineNote([products[2]]), "");
    assert.equal(LineNote.generateLineNote([]), "");
});

test("帶入團購資訊時包含截止時間、到貨與自取外送說明", () => {
    const note = LineNote.generateLineNote(products, {
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
    const note = LineNote.generateLineNote(products);
    assert.match(note, /請直接點選群組中的商品訂購卡選擇數量/);
    assert.match(note, /不用在聊天室留言＋1/);
    assert.doesNotMatch(note, /undefined|null/);
});
