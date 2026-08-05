// 一個商品、多個口味／款式：LINE 商品卡發布（一般管理員 Modal，不是新手精靈）驗收測試。
// 用 vm 沙箱載入真正的 app.js（跟 app-product-groups.test.js 相同手法），
// 驗證「發布到 LINE 群組」這個既有 Modal 現在也能把同一主商品的多個口味合併成一張商品卡發布，
// 不是每個口味各自的舊單商品流程；同時確認一般（沒有分組）商品仍走原本單商品發布流程不受影響。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const CustomerName = require("./customer-name.js");
const LineNote = require("./line-note.js");

function loadApp(options = {}) {
    const store = new Map();
    const noop = () => {};
    const fields = options.fields || {};
    const alerts = [];
    const requests = [];
    const makeElement = (id) => new Proxy({}, {
        get(_target, key) {
            if (key === "style") return {};
            if (key === "classList") return { add: noop, remove: noop, toggle: noop, contains: () => false };
            if (key === "value") return fields[id] !== undefined ? fields[id] : "";
            if (key === "checked") return fields[id + "__checked"] !== undefined ? fields[id + "__checked"] : true;
            if (key === "hidden") return fields[id + "__hidden"] || false;
            if (key === "textContent" || key === "innerHTML") return "";
            if (typeof key === "string" && /^(addEventListener|removeEventListener|focus|click|reset|appendChild|setAttribute)$/.test(key)) return noop;
            return "";
        },
        set(_target, key, value) {
            if (key === "value") fields[id] = value;
            if (key === "checked") fields[id + "__checked"] = value;
            if (key === "hidden") fields[id + "__hidden"] = value;
            return true;
        }
    });
    const elements = new Map();
    const sandbox = {
        console,
        window: { addEventListener: noop, scrollTo: noop },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeElement(id));
                return elements.get(id);
            },
            querySelectorAll: options.querySelectorAll || (() => []),
            addEventListener: noop
        },
        localStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: key => store.delete(key)
        },
        CustomerName,
        LineNote,
        fetch: async (url, init = {}) => {
            requests.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
            const responder = options.respond || (() => ({}));
            return { ok: true, json: async () => responder(url, init) };
        },
        alert: message => alerts.push(String(message)),
        confirm: () => true,
        prompt: () => "",
        setTimeout, clearTimeout
    };
    sandbox.fields = fields;
    sandbox.alerts = alerts;
    sandbox.requests = requests;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"), context, { filename: "app.js" });
    sandbox.setState = patch => {
        Object.entries(patch).forEach(([key, value]) => {
            vm.runInContext(`state.${key} = ${JSON.stringify(value)};`, context);
        });
    };
    sandbox.setApiKey = key => store.set("easygo_line_admin_api_key", key);
    sandbox.getState = () => vm.runInContext("state", context);
    sandbox.runInApp = code => vm.runInContext(code, context);
    return sandbox;
}

const groupedProducts = [
    { id: "P031-A", name: "水蜜桃 A.6粒", variantName: "A.6粒", productGroupId: "PG031", variantSort: 0, price: 400, pickupPrice: 400, deliveryPrice: 420, unit: "份", enabled: true, photo: "" },
    { id: "P031-B", name: "水蜜桃 B.8粒", variantName: "B.8粒", productGroupId: "PG031", variantSort: 1, price: 350, pickupPrice: 350, deliveryPrice: 370, unit: "份", enabled: true, photo: "" }
];
const productGroups = [{ id: "PG031", name: "水蜜桃", description: "", imageUrl: "https://img.example/pg031.png", enabled: true }];

test("app.js 載入後，LINE 商品卡合併發布相關函式都存在", () => {
    const app = loadApp();
    assert.equal(typeof app.buildLinePublishEntries, "function");
    assert.equal(typeof app.findLinePublishEntry, "function");
    assert.equal(typeof app.openLinePublishModal, "function");
    assert.equal(typeof app.updateLineFlexPreview, "function");
    assert.equal(typeof app.publishLineProduct, "function");
});

test("buildLinePublishEntries：同一主商品的多個口味合併成一個選項，一般商品仍各自一個選項", () => {
    const app = loadApp();
    app.setState({ productGroups });
    const entries = app.buildLinePublishEntries([
        ...groupedProducts,
        { id: "P001", name: "高麗菜水餃", price: 120, unit: "包", enabled: true, photo: "" }
    ]);
    assert.equal(entries.length, 2);
    const groupEntry = entries.find(e => e.isGroup);
    const singleEntry = entries.find(e => !e.isGroup);
    assert.equal(groupEntry.productGroupId, "PG031");
    assert.equal(groupEntry.variants.length, 2);
    assert.match(groupEntry.label, /水蜜桃/);
    assert.match(groupEntry.label, /共2種口味／款式合併為一張商品卡/);
    assert.equal(singleEntry.productId, "P001");
});

test("發布合併商品卡：呼叫 EasyGoApp.publishGroupCard（帶 product_group_id），不是逐口味發布的舊流程", async () => {
    const app = loadApp();
    app.setApiKey("test-key");
    app.setState({
        groupBuys: [{ id: "GB1", name: "測試團購", productIds: ["P031-A", "P031-B"], endDate: "2026-08-31", notes: "" }],
        activeGroupBuyId: "GB1",
        productGroups,
        products: groupedProducts
    });

    await app.openLinePublishModal("GB1");
    // 手動模擬使用者在下拉選單選到合併選項、選好 LINE 群組
    app.fields["line-publish-product"] = "group:PG031";
    app.fields["line-publish-group"] = "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

    await app.publishLineProduct();

    const publishCalls = app.requests.filter(r => r.url.includes("/api/line/publish"));
    const groupSyncCalls = app.requests.filter(r => r.url.includes("/api/group-buys/GB1") && r.method === "PUT");
    assert.equal(publishCalls.length, 1, "應該只呼叫一次合併發布，不是每個口味各發一次");
    assert.equal(publishCalls[0].body.product_group_id, "PG031");
    assert.equal(publishCalls[0].body.product_id, undefined);
    assert.equal(groupSyncCalls.length, 1, "publishGroupCard 內部應該先同步團購，走既有 syncGroup，不建立新流程");
    assert.deepEqual(groupSyncCalls[0].body.product_ids, ["P031-A", "P031-B"]);
    assert.equal(app.alerts.some(a => a.includes("合併商品卡發布成功")), true);
});

test("團購商品勾選清單是空的（舊資料「全選」語意）時，發布合併卡仍會把該主商品所有口味併入 productIds 再同步，不會把 group_buy_products 清空", async () => {
    const app = loadApp();
    app.setApiKey("test-key");
    app.setState({
        // productIds 故意留空，模擬管理員從沒在「團購活動」勾選清單裡勾過這兩個口味的真實情境
        // （前台商品管理頁用「留空＝全部商品」當 fallback 顯示，但後端同步是照字面重建 group_buy_products）。
        groupBuys: [{ id: "GB1", name: "測試團購", productIds: [], endDate: "2026-08-31", notes: "" }],
        activeGroupBuyId: "GB1",
        productGroups,
        products: groupedProducts
    });

    await app.openLinePublishModal("GB1");
    app.fields["line-publish-product"] = "group:PG031";
    app.fields["line-publish-group"] = "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

    await app.publishLineProduct();

    const groupSyncCalls = app.requests.filter(r => r.url.includes("/api/group-buys/GB1") && r.method === "PUT");
    assert.equal(groupSyncCalls.length, 1);
    assert.deepEqual(
        new Set(groupSyncCalls[0].body.product_ids),
        new Set(["P031-A", "P031-B"]),
        "即使團購原本的 productIds 是空的，發布合併卡時也要把這個主商品的所有口味補進去，不能同步出空陣列把關聯清光"
    );
    assert.deepEqual(new Set(app.getState().groupBuys[0].productIds), new Set(["P031-A", "P031-B"]));
});

test("一般（沒有分組）商品仍走原本單商品發布流程：一個商品一張卡、可選數量按鈕", async () => {
    const app = loadApp({ querySelectorAll: selector => (selector === ".line-publish-quantity:checked" ? [{ value: "1" }] : []) });
    app.setApiKey("test-key");
    app.setState({
        groupBuys: [{ id: "GB2", name: "測試團購2", productIds: ["P001"], endDate: "2026-08-31", notes: "" }],
        activeGroupBuyId: "GB2",
        productGroups: [],
        products: [{ id: "P001", name: "高麗菜水餃", specs: "20顆", price: 120, unit: "包", enabled: true, photo: "" }]
    });

    await app.openLinePublishModal("GB2");
    app.fields["line-publish-product"] = "p:P001";
    app.fields["line-publish-group"] = "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

    await app.publishLineProduct();

    const publishCalls = app.requests.filter(r => r.url.includes("/api/line/publish"));
    assert.equal(publishCalls.length, 1);
    assert.equal(publishCalls[0].body.product_id, "P001");
    assert.equal(publishCalls[0].body.product_group_id, undefined);
});

test("updateLineFlexPreview：合併選項時隱藏數量按鈕組合，一般商品維持顯示", () => {
    const app = loadApp();
    app.setApiKey("test-key");
    app.setState({
        groupBuys: [{ id: "GB1", name: "測試團購", productIds: ["P031-A", "P031-B"], endDate: "2026-08-31", notes: "" }],
        activeGroupBuyId: "GB1",
        productGroups,
        products: groupedProducts
    });
    app.runInApp("openLinePublishModal('GB1')");
    app.fields["line-publish-group-buy-id"] = "GB1";
    app.fields["line-publish-product"] = "group:PG031";
    app.runInApp("updateLineFlexPreview()");
    assert.equal(app.fields["line-publish-quantity-fieldset__hidden"], true);

    app.fields["line-publish-product"] = "p:P031-A";
    app.runInApp(`
        linePublishEntries.push({ key: "p:P031-A", label: "single", isGroup: false, productId: "P031-A", product: state.products[0] });
    `);
    app.runInApp("updateLineFlexPreview()");
    assert.equal(app.fields["line-publish-quantity-fieldset__hidden"], false);
});
