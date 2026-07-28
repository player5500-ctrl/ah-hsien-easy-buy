const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const CustomerName = require("./customer-name.js");

function loadApp() {
    const elements = new Map();
    const makeElement = () => ({
        value: "",
        textContent: "",
        innerHTML: "",
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        reset() {}
    });
    const sandbox = {
        console,
        CustomerName,
        window: { addEventListener() {}, print() {}, scrollTo() {} },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeElement());
                return elements.get(id);
            },
            querySelectorAll() { return []; },
            querySelector() { return null; },
            addEventListener() {}
        },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        alert() {},
        confirm() { return false; },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        setTimeout,
        clearTimeout,
        crypto: { randomUUID: () => "test-id" }
    };
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"), context, { filename: "app.js" });
    sandbox.setState = value => vm.runInContext(`state = ${JSON.stringify(value)};`, context);
    sandbox.elements = elements;
    return sandbox;
}

test("Excel 商品數量統計包含進貨、保留、可賣、有效已售、取消回補、剩餘與狀態", () => {
    const app = loadApp();
    app.setState({
        groupBuys: [{ id: "GB1", name: "測試團", productIds: ["P1"] }],
        products: [{ id: "P1", name: "Pril檸檬", specs: "653ml×3瓶", unit: "組", enabled: true }],
        customers: [],
        orders: [
            { id: "O1", groupBuyId: "GB1", customerId: "C1", orderStatus: "新訂單", items: [{ productId: "P1", quantity: 25 }] },
            { id: "O2", groupBuyId: "GB1", customerId: "C2", orderStatus: "已取消", items: [{ productId: "P1", quantity: 4 }] }
        ],
        lineInbox: [],
        groupBuyStock: {
            "GB1::P1": {
                groupBuyId: "GB1", productId: "P1", stockEnabled: true,
                incomingQuantity: 30, reservedQuantity: 2, sellableQuantity: 28,
                soldQuantity: 25, remainingQuantity: 3, lowStockThreshold: 5,
                stockStatus: "low_stock"
            }
        },
        inventoryMovements: [{
            group_buy_id: "GB1", product_id: "P1", movement_type: "order_cancelled", quantity_change: 4
        }],
        activeGroupBuyId: "GB1"
    });

    const rows = app.buildProductInventoryExportRows("GB1");
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), {
        "商品編號": "P1",
        "商品名稱": "Pril檸檬",
        "規格": "653ml×3瓶",
        "進貨數量": 30,
        "保留數量": 2,
        "可賣數量": 28,
        "已售數量": 25,
        "取消回補數量": 4,
        "剩餘數量": 3,
        "低庫存門檻": 5,
        "庫存狀態": "即將售完",
        "購買客戶數": 1
    });
});

test("商品總量列印包含庫存欄位且不修改包貨單、外送與自取名單", () => {
    const app = loadApp();
    app.setState({
        groupBuys: [{ id: "GB1", name: "測試團", productIds: ["P1"] }],
        products: [{ id: "P1", name: "Pril檸檬", specs: "653ml×3瓶", unit: "組", enabled: true }],
        customers: [],
        orders: [],
        lineInbox: [],
        groupBuyStock: {
            "GB1::P1": {
                groupBuyId: "GB1", productId: "P1", stockEnabled: true,
                sellableQuantity: 9, soldQuantity: 7, remainingQuantity: 2,
                stockStatus: "low_stock", lowStockThreshold: 3
            }
        },
        inventoryMovements: [],
        activeGroupBuyId: "GB1"
    });
    app.printProductTotals();
    const html = app.document.getElementById("print-area").innerHTML;
    assert.match(html, /可賣/);
    assert.match(html, /已售/);
    assert.match(html, /剩餘/);
    assert.match(html, /即將售完/);
    assert.match(html, /inventory-print-table/);
});
