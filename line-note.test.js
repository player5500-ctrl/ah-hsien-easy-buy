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
    assert.match(note, /例如「P001\+2」/);
    assert.doesNotMatch(note, /直接留言「\+2」/);
});

test("單一商品時加入 +N 快速下單說明", () => {
    const note = LineNote.generateLineNote([products[1]]);
    assert.match(note, /只有一樣商品，直接留言「\+2」也可以/);
    assert.match(note, /例如「P002\+2」/);
});

test("沒有啟用商品時回傳空字串", () => {
    assert.equal(LineNote.generateLineNote([products[2]]), "");
    assert.equal(LineNote.generateLineNote([]), "");
});
