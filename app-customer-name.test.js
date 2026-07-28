// 前端名稱解析驗收：在 vm 沙箱載入實際的 app.js，驗證後台所有畫面共用的
// orderCustomerName() / customerDisplayName() 優先順序與實際出貨的程式碼一致。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const CustomerName = require("./customer-name.js");

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
            if (key === "checked") return false;
            if (key === "textContent" || key === "innerHTML") return "";
            if (typeof key === "string" && /^(addEventListener|removeEventListener|focus|click|reset|appendChild)$/.test(key)) return noop;
            return "";
        },
        set(_target, key, value) {
            if (key === "value") fields[id] = value;
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
        fetch: async (url, init = {}) => {
            requests.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
            const responder = options.respond || (() => ({}));
            return { ok: true, json: async () => responder(url, init) };
        },
        alert: message => alerts.push(String(message)),
        confirm: () => false,
        setTimeout, clearTimeout
    };
    sandbox.fields = fields;
    sandbox.alerts = alerts;
    sandbox.requests = requests;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"), context, { filename: "app.js" });
    // app.js 的 state 是 let（詞法宣告，不會掛在 sandbox 上），要透過 runInContext 存取。
    sandbox.setCustomers = list => vm.runInContext(`state.customers = ${JSON.stringify(list)};`, context);
    sandbox.setOrders = list => vm.runInContext(`state.orders = ${JSON.stringify(list)};`, context);
    return sandbox;
}

test("app.js 可載入，且名稱解析函式存在", () => {
    const app = loadApp();
    assert.equal(typeof app.orderCustomerName, "function");
    assert.equal(typeof app.customerDisplayName, "function");
    assert.equal(typeof app.syncCustomerToCloud, "function");
    assert.equal(typeof app.syncCustomersFromCloud, "function");
});

test("後台所有畫面：訂單顯示名稱一律以 customerId 關聯客戶取目前名稱", () => {
    const app = loadApp();
    app.setCustomers([
        { id: "LINE-abc", customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶", nickname: "024-蜜茶", phone: "", address: "" },
        { id: "LINE-def", customDisplayName: null, lineDisplayName: "阿明", nickname: "阿明", phone: "", address: "" },
        { id: "A001", nickname: "legacy 客戶", phone: "", address: "" }
    ]);
    // 案例四：訂單存的是下單當時的 LINE 原始名稱「蜜茶」，畫面仍要顯示「024-蜜茶」
    assert.equal(app.orderCustomerName({ customerId: "LINE-abc", customerNickname: "蜜茶" }), "024-蜜茶");
    // 案例五：清空自訂名稱 → 回退 LINE 原始名稱
    assert.equal(app.orderCustomerName({ customerId: "LINE-def", customerNickname: "阿明" }), "阿明");
    // 舊資料只有 legacy nickname
    assert.equal(app.orderCustomerName({ customerId: "A001", customerNickname: "舊名" }), "legacy 客戶");
    // 找不到客戶 → 回退訂單歷史名稱
    assert.equal(app.orderCustomerName({ customerId: "GONE", customerNickname: "歷史名稱" }), "歷史名稱");
    // 完全沒有名稱 → 未知客戶，不得出現空白/null/undefined
    assert.equal(app.orderCustomerName({ customerId: "GONE" }), "未知客戶");
    assert.equal(app.orderCustomerName(null), "未知客戶");
    assert.equal(app.orderCustomerNameForSort({ customerId: "GONE" }), "未知客戶");
});

test("雲端同步不得用 LINE 原始名稱蓋掉團主自訂名稱", () => {
    const app = loadApp();
    app.setCustomers([{ id: "LINE-abc", customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶", nickname: "024-蜜茶" }]);
    // 模擬 /api/customers 回傳（雲端仍保有團主自訂名稱）
    const cloudRow = { id: "LINE-abc", custom_display_name: "024-蜜茶", line_display_name: "蜜茶", profile_status: "pending" };
    assert.equal(app.customerDisplayName({
        customDisplayName: cloudRow.custom_display_name,
        lineDisplayName: cloudRow.line_display_name
    }), "024-蜜茶");
    // 只有 LINE 原始名稱時才顯示 LINE 名稱
    assert.equal(app.customerDisplayName({ customDisplayName: null, lineDisplayName: "蜜茶" }), "蜜茶");
    assert.equal(app.customerDisplayName({}), "未知客戶");
});

// --- 回歸測試：程式碼審查抓到的三個真實 bug ---

function customerFields(overrides) {
    return {
        "cust-id": "LINE-316ca0ef",
        "cust-nickname": "",
        "cust-phone": "",
        "cust-address": "",
        "cust-notes": "",
        "customer-edit-mode": "edit",
        ...overrides
    };
}

test("回歸 B1：LINE 自動建立的客戶（小寫 hex 編號）改名要真的存進本機並 PUT 到正確路徑", () => {
    const app = loadApp({
        fields: customerFields({ "cust-nickname": "024-蜜茶" }),
        respond: () => ({ id: "LINE-316ca0ef", updated: true })
    });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([{ id: "LINE-316ca0ef", customDisplayName: null, lineDisplayName: "蜜茶", nickname: "蜜茶", phone: "", address: "" }]);

    app.saveCustomer();

    const saved = JSON.parse(app.localStorage.getItem("easygo_customers"));
    assert.equal(saved.length, 1, "不得建立第二筆（幽靈）客戶");
    assert.equal(saved[0].id, "LINE-316ca0ef", "客戶編號不得被大寫化");
    assert.equal(saved[0].customDisplayName, "024-蜜茶");
    assert.equal(saved[0].lineDisplayName, "蜜茶", "LINE 原始名稱要保留");
    assert.equal(app.orderCustomerName({ customerId: "LINE-316ca0ef", customerNickname: "蜜茶" }), "024-蜜茶");

    const put = app.requests.find(r => r.method === "PUT");
    assert.ok(put, "必須把團主自訂名稱 PUT 到雲端");
    assert.match(put.url, /\/api\/customers\/LINE-316ca0ef$/);
    assert.equal(put.body.custom_display_name, "024-蜜茶");
    assert.equal("address" in put.body, false, "回歸 B2：地址留空不得上傳，避免清掉 LIFF 地址");
});

test("回歸 B1：編輯不存在的客戶要報錯，不得誤建雲端客戶", () => {
    const app = loadApp({ fields: customerFields({ "cust-nickname": "024-蜜茶" }) });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([]);
    app.saveCustomer();
    assert.ok(app.alerts.some(m => m.includes("找不到客戶編號")));
    assert.equal(app.requests.filter(r => r.method === "PUT").length, 0);
});

test("案例五（前端）：LINE 客戶清空暱稱可以存檔，並回退顯示 LINE 原始名稱", () => {
    const app = loadApp({ fields: customerFields({ "cust-nickname": "" }) });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([{ id: "LINE-316ca0ef", customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶", nickname: "024-蜜茶", phone: "", address: "" }]);
    app.saveCustomer();
    assert.equal(app.alerts.some(m => m.includes("請輸入客戶暱稱")), false, "LINE 客戶允許清空自訂名稱");
    const saved = JSON.parse(app.localStorage.getItem("easygo_customers"));
    assert.equal(saved[0].customDisplayName, null);
    assert.equal(saved[0].nickname, "蜜茶");
    assert.equal(app.orderCustomerName({ customerId: "LINE-316ca0ef", customerNickname: "蜜茶" }), "蜜茶");
});

test("回歸 B5：沒有自訂名稱的 LINE 客戶，編輯視窗暱稱欄位必須留空", () => {
    const app = loadApp({ fields: customerFields({}) });
    app.setCustomers([
        { id: "LINE-abc", customDisplayName: null, lineDisplayName: "蜜茶", nickname: "蜜茶", phone: "", address: "", notes: "" },
        { id: "LINE-def", customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶", nickname: "024-蜜茶", phone: "", address: "", notes: "" },
        { id: "A001", nickname: "陳小明", phone: "0912", address: "", notes: "" }
    ]);
    app.openCustomerModal("LINE-abc");
    assert.equal(app.fields["cust-nickname"], "", "不可預填 LINE 原始名稱");
    app.openCustomerModal("LINE-def");
    assert.equal(app.fields["cust-nickname"], "024-蜜茶");
    app.openCustomerModal("A001");
    assert.equal(app.fields["cust-nickname"], "陳小明", "舊資料沿用 legacy nickname");
});

test("回歸 B3：雲端沒有自訂名稱時不得把本機剛改好的名稱蓋掉", async () => {
    const app = loadApp({
        respond: () => ([{ id: "LINE-abc", custom_display_name: null, line_display_name: "蜜茶", line_user_id: "U1", address: null, pickup_type: null, profile_status: "pending" }])
    });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([{ id: "LINE-abc", customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶", nickname: "024-蜜茶", phone: "0912", notes: "常客" }]);
    await app.syncCustomersFromCloud();
    const saved = JSON.parse(app.localStorage.getItem("easygo_customers"));
    assert.equal(saved[0].customDisplayName, "024-蜜茶");
    assert.equal(saved[0].nickname, "024-蜜茶");
    assert.equal(saved[0].phone, "0912", "本機電話不得遺失");
    assert.equal(saved[0].notes, "常客", "本機備註不得遺失");
});

test("客戶管理必須看得到雲端客戶（含 LINE 自動建立的），否則團主無法設定名稱", async () => {
    const app = loadApp({
        respond: () => ([
            { id: "LINE-zzz", custom_display_name: null, line_display_name: "蜜茶", line_user_id: "U9", address: null, pickup_type: null, profile_status: "pending" },
            { id: "A001", custom_display_name: "陳小明", line_display_name: null, line_user_id: null, address: "台北市", pickup_type: "外送", profile_status: "complete" }
        ])
    });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([]);
    await app.syncCustomersFromCloud();
    const saved = JSON.parse(app.localStorage.getItem("easygo_customers") || "[]");
    assert.equal(saved.length, 2, "本機沒有的雲端客戶要建出來");
    const micha = saved.find(c => c.id === "LINE-zzz");
    assert.equal(app.customerDisplayName(micha), "蜜茶");
    assert.equal(micha.phone, "", "renderCustomers 會讀 phone.includes()，不可為 undefined");
    assert.equal(typeof micha.address, "string");
    assert.equal(micha.notes, "LINE 自動建立，請補齊電話與地址");
    const ming = saved.find(c => c.id === "A001");
    assert.equal(app.customerDisplayName(ming), "陳小明");
    assert.equal(ming.address, "台北市");
});

test("雲端已刪除的 LINE 暫存客戶：只剩已取消零元空訂單時要清掉本機殘影", async () => {
    const app = loadApp({
        respond: () => ([
            { id: "A001", custom_display_name: "蜜茶", line_display_name: null, profile_status: "complete" }
        ])
    });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([
        { id: "LINE-stale", nickname: "蜜茶" },
        { id: "A001", nickname: "蜜茶" }
    ]);
    app.setOrders([
        { id: "ORD-cancelled-1", customerId: "LINE-stale", orderStatus: "已取消", totalAmount: 0, items: [] },
        { id: "ORD-cancelled-2", customerId: "LINE-stale", orderStatus: "已取消", totalAmount: 0, items: [] },
        { id: "ORD-valid", customerId: "A001", orderStatus: "新訂單", totalAmount: 140, items: [{ productId: "P001", qty: 1 }] }
    ]);

    await app.syncCustomersFromCloud();

    const customers = JSON.parse(app.localStorage.getItem("easygo_customers"));
    const orders = JSON.parse(app.localStorage.getItem("easygo_orders"));
    assert.deepEqual(customers.map(customer => customer.id), ["A001"]);
    assert.deepEqual(orders.map(order => order.id), ["ORD-valid"]);
});

test("雲端缺少客戶但仍有有效交易時不得清除本機資料", async () => {
    const app = loadApp({ respond: () => ([]) });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([{ id: "LINE-active", nickname: "正常客戶" }]);
    app.setOrders([
        { id: "ORD-active", customerId: "LINE-active", orderStatus: "新訂單", totalAmount: 200, items: [{ productId: "P001", qty: 1 }] }
    ]);
    app.saveStateToStorage();

    await app.syncCustomersFromCloud();

    const customers = JSON.parse(app.localStorage.getItem("easygo_customers"));
    const orders = JSON.parse(app.localStorage.getItem("easygo_orders"));
    assert.deepEqual(customers.map(customer => customer.id), ["LINE-active"]);
    assert.deepEqual(orders.map(order => order.id), ["ORD-active"]);
});

// --- migration-008：備註（本名）要跨裝置 round-trip（本機 → 雲端 → 本機） ---

test("migration-008：存檔時備註要 PUT 上雲端（含清空），否則換裝置就消失", () => {
    const app = loadApp({
        fields: customerFields({ "cust-nickname": "024-蜜茶", "cust-notes": "本名：陳蜜茶，外送放管理室" }),
        respond: () => ({ id: "LINE-316ca0ef", updated: true })
    });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([{ id: "LINE-316ca0ef", customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶", nickname: "024-蜜茶", phone: "", address: "", notes: "" }]);

    app.saveCustomer();

    const saved = JSON.parse(app.localStorage.getItem("easygo_customers"));
    assert.equal(saved[0].notes, "本名：陳蜜茶，外送放管理室", "本機也要存");
    const put = app.requests.find(r => r.method === "PUT");
    assert.ok(put, "必須 PUT 到雲端");
    assert.equal(put.body.notes, "本名：陳蜜茶，外送放管理室", "備註必須送上雲端");

    // 清空備註同樣要上傳（空字串＝真的要清），否則雲端會一直留著舊備註蓋回本機
    const cleared = loadApp({
        fields: customerFields({ "cust-nickname": "024-蜜茶", "cust-notes": "" }),
        respond: () => ({ id: "LINE-316ca0ef", updated: true })
    });
    cleared.localStorage.setItem("easygo_line_admin_api_key", "secret");
    cleared.setCustomers([{ id: "LINE-316ca0ef", customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶", nickname: "024-蜜茶", phone: "", address: "", notes: "舊備註" }]);
    cleared.saveCustomer();
    const clearedPut = cleared.requests.find(r => r.method === "PUT");
    assert.equal(clearedPut.body.notes, "", "清空要明確送空字串");
    assert.equal(JSON.parse(cleared.localStorage.getItem("easygo_customers"))[0].notes, "");
});

test("migration-008：雲端有備註就用雲端值（跨裝置），雲端沒有才保留本機值", async () => {
    const app = loadApp({
        respond: () => ([
            { id: "A001", custom_display_name: "001-蔡清景", line_display_name: "蔡清景", line_user_id: null, address: null, pickup_type: null, notes: "雲端備註（另一台存的）", profile_status: "complete" },
            { id: "A002", custom_display_name: "002-鄭雅蘭", line_display_name: "鄭雅蘭", line_user_id: null, address: null, pickup_type: null, notes: null, profile_status: "complete" }
        ])
    });
    app.localStorage.setItem("easygo_line_admin_api_key", "secret");
    app.setCustomers([
        { id: "A001", customDisplayName: "001-蔡清景", lineDisplayName: "蔡清景", nickname: "001-蔡清景", phone: "0912", address: "", notes: "" },
        { id: "A002", customDisplayName: "002-鄭雅蘭", lineDisplayName: "鄭雅蘭", nickname: "002-鄭雅蘭", phone: "", address: "", notes: "本機備註還沒同步上去" }
    ]);
    await app.syncCustomersFromCloud();
    const saved = JSON.parse(app.localStorage.getItem("easygo_customers"));
    assert.equal(saved.find(c => c.id === "A001").notes, "雲端備註（另一台存的）", "雲端有值＝跨裝置真相來源");
    assert.equal(saved.find(c => c.id === "A002").notes, "本機備註還沒同步上去", "雲端 NULL 不可把本機備註洗掉");
    assert.equal(saved.find(c => c.id === "A001").phone, "0912", "電話仍只存在本機");
});

test("migration-008：舊客戶沒有 notes 欄位時，編輯視窗備註要留空而不是 undefined", () => {
    const app = loadApp({ fields: customerFields({}) });
    app.setCustomers([{ id: "A001", customDisplayName: "001-陳小明", lineDisplayName: "", nickname: "001-陳小明", phone: "", address: "" }]);
    app.openCustomerModal("A001");
    assert.equal(app.fields["cust-notes"], "", "不可顯示字面上的 undefined");
});
