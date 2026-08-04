// 一個商品、多個口味／款式：前端（app.js）驗收測試。
// 用 vm 沙箱載入真正的 app.js（與 app-customer-name.test.js 相同手法），
// 驗證主商品／口味資料在 state.productGroups / state.products / localStorage 的行為，
// 以及搜尋比對與群組狀態徽章邏輯，確保不影響既有沒有 productGroupId 的舊商品。
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
            if (key === "checked") return fields[id + "__checked"] || false;
            if (key === "textContent" || key === "innerHTML") return "";
            if (typeof key === "string" && /^(addEventListener|removeEventListener|focus|click|reset|appendChild)$/.test(key)) return noop;
            return "";
        },
        set(_target, key, value) {
            if (key === "value") fields[id] = value;
            if (key === "checked") fields[id + "__checked"] = value;
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
            querySelectorAll: () => [],
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
    sandbox.setProducts = list => vm.runInContext(`state.products = ${JSON.stringify(list)};`, context);
    sandbox.setProductGroups = list => vm.runInContext(`state.productGroups = ${JSON.stringify(list)};`, context);
    sandbox.setActiveGroupBuy = id => vm.runInContext(`state.activeGroupBuyId = ${JSON.stringify(id)};`, context);
    sandbox.setGroupBuyStock = map => vm.runInContext(`state.groupBuyStock = ${JSON.stringify(map)};`, context);
    sandbox.getState = () => vm.runInContext("state", context);
    // 逃生口：直接在 app.js 的 vm context 內執行任意程式碼（用於存取／改寫 let 宣告的模組內變數，
    // 例如 productGroupDraft 不像 state 有 getState() 這種現成的存取函式）。
    sandbox.runInApp = code => vm.runInContext(code, context);
    return sandbox;
}

test("app.js 載入後，一個商品多個口味相關函式與 state.productGroups 都存在", () => {
    const app = loadApp();
    assert.equal(typeof app.upsertLocalProductGroupFromServer, "function");
    assert.equal(typeof app.saveProductGroup, "function");
    assert.equal(typeof app.openAddProductChoice, "function");
    assert.equal(typeof app.renderProducts, "function");
    assert.equal(app.getState().productGroups.length, 0);
});

test("upsertLocalProductGroupFromServer：把伺服器回傳的主商品＋口味併入 state，並寫入 localStorage", () => {
    const app = loadApp();
    const serverGroup = {
        id: "PG024", name: "德國 Pril 洗碗精", description: "", image_url: null, enabled: 1,
        variants: [
            { id: "P024-A", name: "德國 Pril 洗碗精 檨檬", specs: "653ml", price: 210, pickup_price: 210, delivery_price: 225,
                unit: "瓶", enabled: 1, description: "", image_url: "", product_group_id: "PG024", variant_name: "檨檬", variant_sort: 0, use_group_image: 0 },
            { id: "P024-B", name: "德國 Pril 洗碗精 蘆薈", specs: "750ml", price: 220, pickup_price: 220, delivery_price: 235,
                unit: "瓶", enabled: 1, description: "", image_url: "", product_group_id: "PG024", variant_name: "蘆薈", variant_sort: 1, use_group_image: 0 }
        ]
    };
    app.upsertLocalProductGroupFromServer(serverGroup);

    const state = app.getState();
    assert.equal(state.productGroups.length, 1);
    assert.equal(state.productGroups[0].name, "德國 Pril 洗碗精");
    assert.equal(state.products.length, 2);
    assert.equal(state.products.map(p => p.id).join(","), "P024-A,P024-B");
    assert.equal(state.products[0].variantName, "檨檬");
    assert.equal(state.products[0].productGroupId, "PG024");

    // 已寫入 localStorage，且沒有影響 easygo_products 既有格式
    const savedGroups = JSON.parse(app.localStorage.getItem("easygo_product_groups"));
    const savedProducts = JSON.parse(app.localStorage.getItem("easygo_products"));
    assert.equal(savedGroups.length, 1);
    assert.equal(savedProducts.length, 2);

    // 再次呼叫（例如新增第三個口味後重新整理）：更新既有的、附加新的，不重複
    const updatedGroup = {
        ...serverGroup,
        variants: [
            ...serverGroup.variants,
            { id: "P024-C", name: "德國 Pril 洗碗精 茶樹", specs: "", price: 230, pickup_price: null, delivery_price: null,
                unit: "瓶", enabled: 1, description: "", image_url: "", product_group_id: "PG024", variant_name: "茶樹", variant_sort: 2, use_group_image: 0 }
        ]
    };
    app.upsertLocalProductGroupFromServer(updatedGroup);
    const state2 = app.getState();
    assert.equal(state2.productGroups.length, 1, "同一個主商品不應該被新增成第二筆");
    assert.equal(state2.products.length, 3, "應該只新增第三個口味，不重複既有兩個");
});

test("舊商品（沒有 productGroupId）完全不受影響：搜尋與資料結構維持原樣", () => {
    const app = loadApp();
    app.setProducts([
        { id: "P001", name: "高麗菜水餃", specs: "20顆", price: 120, unit: "包", enabled: true }
    ]);
    const state = app.getState();
    assert.equal(state.products[0].productGroupId, undefined);
    assert.equal(typeof app.productMatchesSearch, "function");
    assert.equal(app.productMatchesSearch(state.products[0], null, "高麗菜"), true);
    assert.equal(app.productMatchesSearch(state.products[0], null, "找不到的字串"), false);
});

test("productMatchesSearch：可比對主商品名稱、口味名稱、商品代碼與規格", () => {
    const app = loadApp();
    const group = { id: "PG024", name: "德國 Pril 洗碗精", description: "" };
    const variant = { id: "P024-A", name: "德國 Pril 洗碗精 檨檬", specs: "653ml x 3瓶", variantName: "檨檬", productGroupId: "PG024" };
    assert.equal(app.productMatchesSearch(variant, group, "德國"), true, "應可比對主商品名稱");
    assert.equal(app.productMatchesSearch(variant, group, "檨檬"), true, "應可比對口味名稱");
    assert.equal(app.productMatchesSearch(variant, group, "p024-a"), true, "應可比對商品代碼（不分大小寫）");
    assert.equal(app.productMatchesSearch(variant, group, "653ml"), true, "應可比對規格");
    assert.equal(app.productMatchesSearch(variant, group, "完全不相關"), false);
});

test("productGroupStatusLabel：全部有貨＝開放訂購，部分售完＝部分口味售完，全部售完＝全部售完", () => {
    const app = loadApp();
    app.setActiveGroupBuy("GB001");
    const group = { id: "PG024", name: "德國 Pril 洗碗精", enabled: true };
    const variants = [
        { id: "P024-A", enabled: true }, { id: "P024-B", enabled: true }
    ];

    app.setGroupBuyStock({});
    assert.equal(app.productGroupStatusLabel(group, variants).text, "開放訂購");

    app.setGroupBuyStock({
        "GB001::P024-A": { stockEnabled: true, remainingQuantity: 0 },
        "GB001::P024-B": { stockEnabled: true, remainingQuantity: 5 }
    });
    assert.equal(app.productGroupStatusLabel(group, variants).text, "部分口味售完");

    app.setGroupBuyStock({
        "GB001::P024-A": { stockEnabled: true, remainingQuantity: 0 },
        "GB001::P024-B": { stockEnabled: true, remainingQuantity: 0 }
    });
    assert.equal(app.productGroupStatusLabel(group, variants).text, "全部售完");

    assert.equal(app.productGroupStatusLabel({ ...group, enabled: false }, variants).text, "已停用");
});

test("saveProductGroup：呼叫 POST /api/product-groups 並帶入 request_id 防重複點擊，成功後併入本機狀態", async () => {
    let createCalled = 0;
    const app = loadApp({
        respond: (url, init) => {
            if (url.endsWith("/api/product-groups") && init.method === "POST") {
                createCalled += 1;
                const body = JSON.parse(init.body);
                assert.ok(body.request_id, "建立主商品必須帶 request_id 防止重複點擊");
                assert.equal(body.name, "德國 Pril 洗碗精");
                assert.equal(body.variants.length, 2);
                return { id: "PG024", variantIds: ["P024-A", "P024-B"], created: true };
            }
            if (url.includes("/api/product-groups/PG024")) {
                return {
                    id: "PG024", name: "德國 Pril 洗碗精", description: "", image_url: null, enabled: 1,
                    variants: [
                        { id: "P024-A", name: "德國 Pril 洗碗精 檨檬", specs: "", price: 210, pickup_price: 210, delivery_price: 210,
                            unit: "瓶", enabled: 1, product_group_id: "PG024", variant_name: "檨檬", variant_sort: 0, use_group_image: 0 },
                        { id: "P024-B", name: "德國 Pril 洗碗精 蘆薈", specs: "", price: 210, pickup_price: 210, delivery_price: 210,
                            unit: "瓶", enabled: 1, product_group_id: "PG024", variant_name: "蘆薈", variant_sort: 1, use_group_image: 0 }
                    ]
                };
            }
            return {};
        }
    });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    // 模擬使用者開啟新增多口味 Modal（此時表單會先被畫面渲染成空白），
    // 然後才像真人一樣在表單欄位打字、勾選「所有口味使用相同價格」、輸入兩個口味名稱。
    app.openProductGroupModal();
    app.fields["pg-name"] = "德國 Pril 洗碗精";
    app.fields["pg-shared-price"] = "210";
    app.fields["pg-same-price__checked"] = true;
    app.runInApp(`productGroupDraft.variants = ${JSON.stringify([
        { key: "v1", variantName: "檨檬", specs: "", price: "", pickupPrice: "", deliveryPrice: "", photo: "", enabled: true },
        { key: "v2", variantName: "蘆薈", specs: "", price: "", pickupPrice: "", deliveryPrice: "", photo: "", enabled: true }
    ])};`);

    await app.saveProductGroup();

    assert.equal(createCalled, 1, "只應該呼叫一次建立主商品 API");
    const state = app.getState();
    assert.equal(state.productGroups.length, 1);
    assert.equal(state.products.length, 2);
    assert.equal(state.products.map(p => p.id).join(","), "P024-A,P024-B");
});

test("停用整組後沒有其他方式重新開啟——現在補上 enableWholeProductGroup，只改主商品 enabled，不強制打開每個口味", async () => {
    let putBody = null;
    const app = loadApp({
        respond: (url, init) => {
            if (url.includes("/api/product-groups/PG031") && init.method === "PUT") {
                putBody = JSON.parse(init.body);
                return {};
            }
            return {};
        }
    });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setProductGroups([{ id: "PG031", name: "水蜜桃", description: "", imageUrl: "", enabled: false }]);
    app.setProducts([
        { id: "P031-A", name: "水蜜桃 A.6粒", variantName: "A.6粒", productGroupId: "PG031", variantSort: 0, price: 400, enabled: true },
        { id: "P031-B", name: "水蜜桃 B.8粒", variantName: "B.8粒", productGroupId: "PG031", variantSort: 1, price: 350, enabled: false }
    ]);

    assert.equal(typeof app.enableWholeProductGroup, "function");
    await app.enableWholeProductGroup("PG031");

    assert.equal(putBody.enabled, true, "PUT 給後端的 enabled 應該是 true");
    const state = app.getState();
    assert.equal(state.productGroups[0].enabled, true, "主商品本身要變成啟用");
    assert.equal(state.products.find(p => p.id === "P031-A").enabled, true, "沒有被硬改的口味維持原狀");
    assert.equal(state.products.find(p => p.id === "P031-B").enabled, false, "啟用整組不會連帶打開原本就停用的口味");
});

test("商品清單：主商品已停用時顯示「啟用整組」按鈕，啟用中時顯示「停用整組」", () => {
    const app = loadApp();
    app.setProductGroups([{ id: "PG031", name: "水蜜桃", description: "", imageUrl: "", enabled: false }]);
    app.setProducts([
        { id: "P031-A", name: "水蜜桃 A.6粒", variantName: "A.6粒", productGroupId: "PG031", variantSort: 0, price: 400, enabled: true }
    ]);
    app.setActiveGroupBuy("");
    app.runInApp("renderProducts();");

    const source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
    assert.match(source, /group\.enabled[\s\S]{0,80}啟用整組/);
    assert.match(source, /onclick="enableWholeProductGroup\('\$\{group\.id\}'\)"/);
});
