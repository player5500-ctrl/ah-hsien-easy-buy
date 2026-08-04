// 一個商品、多個口味／款式：Excel 匯出新增的兩張表（商品群組總覽／口味明細）與訂單搜尋擴充驗收。
// 沿用 app-inventory-report.test.js 的 vm 沙箱手法載入真正的 app.js。
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
    return sandbox;
}

function baseGroupedState(overrides = {}) {
    return {
        groupBuys: [{ id: "GB1", name: "七月團購", productIds: ["P024-A", "P024-B"] }],
        productGroups: [{ id: "PG024", name: "德國 Pril 洗碗精", description: "", imageUrl: "", enabled: true }],
        products: [
            { id: "P024-A", name: "德國 Pril 洗碗精 檨檬", specs: "653ml", unit: "瓶", enabled: true, productGroupId: "PG024", variantName: "檨檬", variantSort: 0 },
            { id: "P024-B", name: "德國 Pril 洗碗精 蘆薈", specs: "750ml", unit: "瓶", enabled: true, productGroupId: "PG024", variantName: "蘆薈", variantSort: 1 }
        ],
        customers: [],
        orders: [],
        lineInbox: [],
        groupBuyStock: {},
        inventoryMovements: [],
        activeGroupBuyId: "GB1",
        ...overrides
    };
}

test("沒有任何多口味商品時，商品群組總覽與口味明細都是空陣列（不會多出空白工作表）", () => {
    const app = loadApp();
    app.setState({
        groupBuys: [{ id: "GB1", name: "測試團", productIds: ["P1"] }],
        productGroups: [],
        products: [{ id: "P1", name: "Pril檸檬", specs: "653ml×3瓶", unit: "組", enabled: true }],
        customers: [], orders: [], lineInbox: [], groupBuyStock: {}, inventoryMovements: [], activeGroupBuyId: "GB1"
    });
    assert.equal(app.buildProductGroupExportRows("GB1").length, 0);
    assert.equal(app.buildVariantDetailExportRows("GB1").length, 0);
});

test("商品群組總覽：兩個口味都還有貨＝開放訂購，且彙總已售／剩餘數量", () => {
    const app = loadApp();
    app.setState(baseGroupedState({
        groupBuyStock: {
            "GB1::P024-A": { stockEnabled: true, incomingQuantity: 20, reservedQuantity: 0, sellableQuantity: 20, soldQuantity: 5, remainingQuantity: 15, lowStockThreshold: 3, stockStatus: "in_stock" },
            "GB1::P024-B": { stockEnabled: true, incomingQuantity: 10, reservedQuantity: 0, sellableQuantity: 10, soldQuantity: 8, remainingQuantity: 2, lowStockThreshold: 3, stockStatus: "in_stock" }
        }
    }));
    const rows = JSON.parse(JSON.stringify(app.buildProductGroupExportRows("GB1")));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
        "主商品編號": "PG024",
        "主商品名稱": "德國 Pril 洗碗精",
        "口味數量": 2,
        "已售數量合計": 13,
        "剩餘數量合計": 17,
        "整組狀態": "開放訂購"
    });
});

test("商品群組總覽：一個口味售完、另一個還有貨＝部分口味售完；兩個都售完＝全部售完", () => {
    const app = loadApp();
    app.setState(baseGroupedState({
        groupBuyStock: {
            "GB1::P024-A": { stockEnabled: true, incomingQuantity: 5, reservedQuantity: 0, sellableQuantity: 5, soldQuantity: 5, remainingQuantity: 0, lowStockThreshold: 3, stockStatus: "sold_out" },
            "GB1::P024-B": { stockEnabled: true, incomingQuantity: 10, reservedQuantity: 0, sellableQuantity: 10, soldQuantity: 8, remainingQuantity: 2, lowStockThreshold: 3, stockStatus: "in_stock" }
        }
    }));
    assert.equal(app.buildProductGroupExportRows("GB1")[0]["整組狀態"], "部分口味售完");

    app.setState(baseGroupedState({
        groupBuyStock: {
            "GB1::P024-A": { stockEnabled: true, incomingQuantity: 5, reservedQuantity: 0, sellableQuantity: 5, soldQuantity: 5, remainingQuantity: 0, lowStockThreshold: 3, stockStatus: "sold_out" },
            "GB1::P024-B": { stockEnabled: true, incomingQuantity: 5, reservedQuantity: 0, sellableQuantity: 5, soldQuantity: 5, remainingQuantity: 0, lowStockThreshold: 3, stockStatus: "sold_out" }
        }
    }));
    assert.equal(app.buildProductGroupExportRows("GB1")[0]["整組狀態"], "全部售完");
});

test("口味明細：每個口味一列，附上所屬主商品編號／名稱與口味名稱，且不影響原本商品數量統計欄位", () => {
    const app = loadApp();
    app.setState(baseGroupedState({
        orders: [
            { id: "O1", groupBuyId: "GB1", customerId: "C1", orderStatus: "新訂單", items: [{ productId: "P024-A", quantity: 3 }] }
        ],
        groupBuyStock: {
            "GB1::P024-A": { stockEnabled: true, incomingQuantity: 20, reservedQuantity: 0, sellableQuantity: 20, soldQuantity: 3, remainingQuantity: 17, lowStockThreshold: 3, stockStatus: "in_stock" },
            "GB1::P024-B": { stockEnabled: true, incomingQuantity: 10, reservedQuantity: 0, sellableQuantity: 10, soldQuantity: 0, remainingQuantity: 10, lowStockThreshold: 3, stockStatus: "in_stock" }
        }
    }));
    const rows = JSON.parse(JSON.stringify(app.buildVariantDetailExportRows("GB1")));
    assert.equal(rows.length, 2);
    const variantA = rows.find(r => r["商品編號"] === "P024-A");
    assert.equal(variantA["主商品編號"], "PG024");
    assert.equal(variantA["主商品名稱"], "德國 Pril 洗碗精");
    assert.equal(variantA["口味名稱"], "檨檬");
    assert.equal(variantA["已售數量"], 3);
    assert.equal(variantA["剩餘數量"], 17);
});

test("訂單搜尋：品項比對範圍擴充到商品代碼與規格，不再只比對商品名稱", () => {
    const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    const renderOrdersStart = appSource.indexOf("// 篩選當前選定團購活動的訂單");
    const pickupFilterStart = appSource.indexOf("// 取貨方式篩選", renderOrdersStart);
    const searchBlock = appSource.slice(renderOrdersStart, pickupFilterStart);
    assert.match(searchBlock, /it\.productName\.toLowerCase\(\)\.includes\(s\)/);
    assert.match(searchBlock, /it\.productId[\s\S]*?includes\(s\)/, "訂單搜尋必須也能比對商品代碼（例如 P024-A）");
    assert.match(searchBlock, /it\.specs[\s\S]*?includes\(s\)/, "訂單搜尋必須也能比對規格");
});
