const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const CustomerName = require("./customer-name.js");

function loadApp() {
    const elements = new Map();
    const storage = new Map([["easygo_line_admin_api_key", "test-admin-key"]]);
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
        localStorage: {
            getItem(key) { return storage.get(key) || null; },
            setItem(key, value) { storage.set(key, value); },
            removeItem(key) { storage.delete(key); }
        },
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
    sandbox.storage = storage;
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

test("核對庫存初次查無團購商品時，會同步本團勾選商品後重新讀取", async () => {
    const app = loadApp();
    app.setState({
        groupBuys: [{
            id: "GB1",
            name: "紐西蘭水果團",
            startDate: "2026-07-01",
            endDate: "2026-07-31",
            status: "開放",
            notes: "",
            productIds: ["P029"],
            stockSettings: []
        }],
        products: [{
            id: "P029",
            name: "紐西蘭富士蘋果",
            specs: "9顆",
            price: 200,
            unit: "顆",
            enabled: true
        }],
        customers: [],
        orders: [],
        lineInbox: [],
        groupBuyStock: {},
        inventoryMovements: [],
        activeGroupBuyId: "GB1"
    });

    const calls = [];
    let reconcileReads = 0;
    app.fetch = async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/api/group-buys/GB1/stock/reconcile")) {
            reconcileReads += 1;
            return {
                ok: true,
                json: async () => reconcileReads === 1
                    ? { differences: [] }
                    : {
                        differences: [{
                            groupBuyId: "GB1",
                            productId: "P029",
                            productCode: "P029",
                            productName: "紐西蘭富士蘋果",
                            stockEnabled: false,
                            soldQuantity: 0,
                            actualSoldQuantity: 0,
                            difference: 0
                        }]
                    }
            };
        }
        return { ok: true, json: async () => ({ synced: true }) };
    };

    await app.openStockReconcileModal("GB1");

    assert.equal(reconcileReads, 2);
    assert.ok(calls.some(call => call.url.endsWith("/api/products/P029") && call.options.method === "PUT"));
    const groupCall = calls.find(call => call.url.endsWith("/api/group-buys/GB1") && call.options.method === "PUT");
    assert.deepEqual(JSON.parse(groupCall.options.body).product_ids, ["P029"]);
    assert.match(app.document.getElementById("stock-reconcile-tbody").innerHTML, /紐西蘭富士蘋果/);
    assert.doesNotMatch(app.document.getElementById("stock-reconcile-tbody").innerHTML, /沒有團購商品/);
});

test("核對庫存沒有明確商品勾選時不擅自同步全部商品", async () => {
    const app = loadApp();
    const alerts = [];
    app.alert = message => alerts.push(message);
    app.setState({
        groupBuys: [{ id: "GB1", name: "舊團購", productIds: [] }],
        products: [{ id: "P029", name: "紐西蘭富士蘋果", enabled: true }],
        customers: [],
        orders: [],
        lineInbox: [],
        groupBuyStock: {},
        inventoryMovements: [],
        activeGroupBuyId: "GB1"
    });
    app.fetch = async () => ({ ok: true, json: async () => ({ differences: [] }) });

    await app.openStockReconcileModal("GB1");

    assert.match(alerts[0], /尚未保存商品勾選資料/);
});

test("核對庫存已有雲端團購商品時保持唯讀，不重複補同步", async () => {
    const app = loadApp();
    app.setState({
        groupBuys: [{ id: "GB1", name: "紐西蘭水果團", productIds: ["P029"] }],
        products: [{ id: "P029", name: "紐西蘭富士蘋果", enabled: true }],
        customers: [],
        orders: [],
        lineInbox: [],
        groupBuyStock: {},
        inventoryMovements: [],
        activeGroupBuyId: "GB1"
    });
    const calls = [];
    app.fetch = async (url, options = {}) => {
        calls.push({ url, options });
        return {
            ok: true,
            json: async () => ({
                differences: [{
                    groupBuyId: "GB1",
                    productId: "P029",
                    productCode: "P029",
                    productName: "紐西蘭富士蘋果",
                    stockEnabled: false,
                    soldQuantity: 0,
                    actualSoldQuantity: 0,
                    difference: 0
                }]
            })
        };
    };

    await app.openStockReconcileModal("GB1");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, undefined);
});
