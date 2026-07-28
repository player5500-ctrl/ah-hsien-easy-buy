// 端到端驗收：LINE 原始名稱「蜜茶」→ 團主改成「024-蜜茶」→ 再次下單／匯出都必須顯示「024-蜜茶」，
// 且不得被 LINE Webhook／商品卡 Postback／LIFF 改回「蜜茶」，也不得產生第二筆客戶。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { fetch: fetchHandler, processPostback, createDependencies } = require("./index.js");
const Liff = require("./liff.js");
const CustomerName = require("../../customer-name.js");

class D1Statement {
    constructor(database, sql, args = []) {
        this.database = database;
        this.sql = sql;
        this.args = args;
    }
    bind(...args) { return new D1Statement(this.database, this.sql, args); }
    async run() {
        const result = this.database.prepare(this.sql).run(...this.args);
        return { meta: { changes: Number(result.changes || 0) } };
    }
    async first() { return this.database.prepare(this.sql).get(...this.args) || null; }
    async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
}

function createEnv() {
    const database = new DatabaseSync(":memory:");
    database.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    database.exec(`
        INSERT INTO products (id, name, enabled, line_code, price, specs, unit) VALUES ('P1', '手工蛋捲', 1, 'P1', 180, '原味12入', '盒');
        INSERT INTO group_buys (id, name, ends_at, status) VALUES ('GB1', '七月團購', '2099-07-31T15:59:59.000Z', 'open');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES ('GB1', 'P1');
        INSERT INTO line_groups (group_id, display_name, active_group_buy_id) VALUES ('G1', '測試群組', 'GB1');
    `);
    const DB = {
        database,
        prepare(sql) { return new D1Statement(database, sql); },
        async batch(statements) {
            database.exec("BEGIN IMMEDIATE");
            try {
                const results = [];
                for (const statement of statements) results.push(await statement.run());
                database.exec("COMMIT");
                return results;
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        }
    };
    return { ADMIN_API_KEY: "secret", LINE_LOGIN_CHANNEL_ID: "login-channel", DB };
}

const AUTH = { authorization: "Bearer secret", "content-type": "application/json" };

function postback(env, webhookEventId, displayName, quantity) {
    return processPostback(env, {
        webhookEventId,
        timestamp: Date.parse("2026-07-22T10:00:00Z"),
        groupId: "G1",
        lineUserId: "U-MICHA",
        displayName,
        data: new URLSearchParams({ action: "set_quantity", groupBuyId: "GB1", productId: "P1", quantity: String(quantity) }).toString()
    });
}

function customerRow(env) {
    return env.DB.database.prepare("SELECT * FROM customers WHERE line_user_id = 'U-MICHA'").get();
}

async function ordersApi(env) {
    const response = await fetchHandler(new Request("https://worker/api/orders?group_buy_id=GB1", { headers: AUTH }), env, {});
    return (await response.json()).orders;
}

async function putCustomer(env, id, body) {
    return fetchHandler(new Request(`https://worker/api/customers/${encodeURIComponent(id)}`, {
        method: "PUT", headers: AUTH, body: JSON.stringify(body)
    }), env, {});
}

test("案例一：新客戶首次下單，只建立一筆客戶且記錄 LINE 原始名稱", async () => {
    const env = createEnv();
    const result = await postback(env, "evt-1", "蜜茶", 2);
    assert.equal(result.processed, true);
    const rows = env.DB.database.prepare("SELECT * FROM customers").all();
    assert.equal(rows.length, 1, "不得建立重複客戶");
    assert.equal(rows[0].line_display_name, "蜜茶");
    assert.equal(rows[0].custom_display_name, null);
    assert.equal(rows[0].nickname, "蜜茶", "legacy nickname 鏡射目前顯示名稱");
});

test("案例二＋三＋八：團主改名後再次下單，顯示 024-蜜茶、不被覆蓋、不產生第二筆客戶", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;

    // 案例二：團主在客戶管理改名
    const saved = await putCustomer(env, customerId, { nickname: "024-蜜茶" });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).customer.customer_display_name, "024-蜜茶");
    assert.equal(customerRow(env).custom_display_name, "024-蜜茶");
    assert.equal(customerRow(env).line_display_name, "蜜茶", "LINE 原始名稱要保留");

    // 案例三：同一個 LINE userId 再次下單（Webhook 又帶回 LINE 原始名稱「蜜茶」）
    const again = await postback(env, "evt-2", "蜜茶", 5);
    assert.equal(again.processed, true);
    const after = customerRow(env);
    assert.equal(after.custom_display_name, "024-蜜茶", "Webhook 不得覆蓋團主設定名稱");
    assert.equal(after.nickname, "024-蜜茶");
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1, "案例八：不得建立第二筆客戶");
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 1, "同一團購共用同一張訂單");

    // 訂單 API（後台訂單列表／詳情／Excel 匯出的資料來源）
    const orders = await ordersApi(env);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].customer_display_name, "024-蜜茶");
    assert.equal(orders[0].custom_display_name, "024-蜜茶");
    assert.equal(orders[0].line_display_name, "蜜茶");

    // 收件匣也要顯示團主設定的名稱
    const inbox = await (await fetchHandler(new Request("https://worker/api/line-inbox", { headers: AUTH }), env, {})).json();
    assert.ok(inbox.length > 0);
    assert.equal(inbox[0].customer_display_name, "024-蜜茶");
    assert.equal(inbox[0].display_name, "蜜茶", "display_name 欄位保留 LINE 原始名稱");
});

test("案例三（LINE 文字下單 +1）：findCustomer 以 line_user_id 命中並回傳團主設定名稱", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    await putCustomer(env, customerId, { nickname: "024-蜜茶" });
    const dependencies = createDependencies(env);
    const found = await dependencies.findCustomer("U-MICHA", "蜜茶");
    assert.equal(found.id, customerId);
    assert.equal(found.displayName, "024-蜜茶");
    // 名稱不可作為識別碼：未知 userId 就算名稱一樣也不得命中已綁定 LINE 的客戶
    assert.equal(await dependencies.findCustomer("U-OTHER", "蜜茶"), null);
});

test("案例四：舊訂單存的是「蜜茶」，改名後仍以 customer_id 關聯顯示 024-蜜茶", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    // 模擬歷史資料：收件匣（下單當時）仍存 LINE 原始名稱
    env.DB.database.prepare("UPDATE line_order_inbox SET customer_nickname = '蜜茶', customer_id = ?").run(customerId);
    await putCustomer(env, customerId, { nickname: "024-蜜茶" });
    const orders = await ordersApi(env);
    assert.equal(orders[0].customer_display_name, "024-蜜茶", "後台預設顯示目前名稱");
    assert.equal(env.DB.database.prepare("SELECT customer_nickname FROM line_order_inbox LIMIT 1").get().customer_nickname, "蜜茶", "歷史名稱紀錄保留");
    // 案例六：匯出用的解析邏輯與畫面完全相同
    assert.equal(CustomerName.resolveDisplayName(orders[0], orders[0].customer_nickname), "024-蜜茶");
});

test("案例五：團主清空自訂名稱後回退 LINE 原始名稱，不得顯示空白或 null", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    await putCustomer(env, customerId, { nickname: "024-蜜茶" });
    const cleared = await putCustomer(env, customerId, { nickname: "" });
    assert.equal(cleared.status, 200);
    const row = customerRow(env);
    assert.equal(row.custom_display_name, null);
    assert.equal(row.nickname, "蜜茶");
    const orders = await ordersApi(env);
    assert.equal(orders[0].customer_display_name, "蜜茶");
});

test("LIFF 自助下單也不得覆蓋團主設定名稱", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    await putCustomer(env, customerId, { nickname: "024-蜜茶" });

    const original = Liff.verifyLineIdToken;
    Liff.verifyLineIdToken = async () => ({ sub: "U-MICHA", name: "蜜茶" });
    try {
        const response = await Liff.handleLiffRoutes(
            new Request("https://worker/api/liff/orders/set-quantity", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ idToken: "t", groupBuyId: "GB1", productId: "P1", quantity: 3, pickupType: "自取" })
            }), env, new URL("https://worker/api/liff/orders/set-quantity"));
        assert.equal(response.status, 200);
    } finally {
        Liff.verifyLineIdToken = original;
    }
    assert.equal(customerRow(env).custom_display_name, "024-蜜茶");
    assert.equal(customerRow(env).nickname, "024-蜜茶");
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1);
});

test("客戶 API：名稱長度驗證、取貨方式驗證、有訂單不可刪除", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    const tooLong = await putCustomer(env, customerId, { nickname: "蜜".repeat(101) });
    assert.equal(tooLong.status, 400);
    const badPickup = await putCustomer(env, customerId, { nickname: "024-蜜茶", pickup_type: "空運" });
    assert.equal(badPickup.status, 400);
    const deleted = await fetchHandler(new Request(`https://worker/api/customers/${customerId}`, { method: "DELETE", headers: AUTH }), env, {});
    assert.equal(deleted.status, 409, "有訂單紀錄的客戶不可刪除");
    const unauthorized = await fetchHandler(new Request("https://worker/api/customers"), env, {});
    assert.equal(unauthorized.status, 401, "客戶 API 必須通過管理金鑰");
});

test("migration-007 可由 migration-006 後的 schema 安全升級並正確回填", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE customers (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, line_user_id TEXT UNIQUE, pickup_type TEXT,
            address TEXT, profile_status TEXT NOT NULL DEFAULT 'complete', created_at TEXT, updated_at TEXT);
        INSERT INTO customers (id, nickname, line_user_id, profile_status) VALUES ('LINE-abc', '蜜茶', 'U1', 'pending');
        INSERT INTO customers (id, nickname, line_user_id, profile_status) VALUES ('A001', '024-蜜茶', 'U2', 'complete');
        INSERT INTO customers (id, nickname, profile_status) VALUES ('A002', '陳小明', 'complete');
    `);
    db.exec(fs.readFileSync(path.join(__dirname, "..", "migration-007-customer-display-name.sql"), "utf8"));
    const auto = db.prepare("SELECT * FROM customers WHERE id = 'LINE-abc'").get();
    assert.equal(auto.line_display_name, "蜜茶");
    assert.equal(auto.custom_display_name, null);
    const bound = db.prepare("SELECT * FROM customers WHERE id = 'A001'").get();
    assert.equal(bound.custom_display_name, "024-蜜茶");
    assert.equal(bound.line_display_name, null);
    assert.equal(db.prepare("SELECT custom_display_name FROM customers WHERE id = 'A002'").get().custom_display_name, "陳小明");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 3, "不得刪除或新增資料列");
    db.close();
});

// --- 回歸測試：程式碼審查抓到的 Worker 端問題 ---

test("回歸 B2：PUT /api/customers 不得清掉客人在 LIFF 填的外送地址", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    env.DB.database.prepare("UPDATE customers SET address = ? WHERE id = ?").run("台北市信義路一段1號", customerId);
    await putCustomer(env, customerId, { nickname: "024-蜜茶", address: "" });
    assert.equal(customerRow(env).address, "台北市信義路一段1號");
    // 有帶非空地址時才更新
    await putCustomer(env, customerId, { nickname: "024-蜜茶", address: "新北市板橋區2號" });
    assert.equal(customerRow(env).address, "新北市板橋區2號");
});

test("回歸 B6：只更新取貨方式時不得把團主自訂名稱清掉", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    await putCustomer(env, customerId, { nickname: "024-蜜茶" });
    await putCustomer(env, customerId, { pickup_type: "自取" });
    assert.equal(customerRow(env).custom_display_name, "024-蜜茶");
    assert.equal(customerRow(env).nickname, "024-蜜茶");
    assert.equal(customerRow(env).pickup_type, "自取");
    // 明確帶空字串才是「清空自訂名稱」
    await putCustomer(env, customerId, { custom_display_name: "" });
    assert.equal(customerRow(env).custom_display_name, null);
});

test("回歸 B4：團主存過名稱的 LINE 暫存客戶仍可在收件匣綁定到正式客戶", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const tempId = customerRow(env).id;
    await putCustomer(env, tempId, { nickname: "024-蜜茶" });
    assert.equal(customerRow(env).profile_status, "pending", "暱稱存檔不得讓暫存客戶失去可合併狀態");
    const messageId = env.DB.database.prepare("SELECT message_id FROM line_order_inbox LIMIT 1").get().message_id;
    const response = await fetchHandler(new Request(`https://worker/api/line-inbox/${encodeURIComponent(messageId)}/bind-customer`, {
        method: "POST", headers: AUTH, body: JSON.stringify({ customer_id: "A001", nickname: "024-蜜茶" })
    }), env, {});
    assert.equal(response.status, 200, await response.text());
    const merged = env.DB.database.prepare("SELECT * FROM customers WHERE id = 'A001'").get();
    assert.equal(merged.line_user_id, "U-MICHA");
    assert.equal(merged.custom_display_name, "024-蜜茶");
    assert.equal(merged.line_display_name, "蜜茶");
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers WHERE id = ?").get(tempId).c, 0, "暫存客戶已合併移除");
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM orders LIMIT 1").get().customer_id, "A001", "訂單已移轉");
});

test("回歸 B7：綁定客戶時要沿用暫存客戶的外送地址", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const tempId = customerRow(env).id;
    env.DB.database.prepare("UPDATE customers SET address = ? WHERE id = ?").run("台北市信義路一段1號", tempId);
    const messageId = env.DB.database.prepare("SELECT message_id FROM line_order_inbox LIMIT 1").get().message_id;
    const response = await fetchHandler(new Request(`https://worker/api/line-inbox/${encodeURIComponent(messageId)}/bind-customer`, {
        method: "POST", headers: AUTH, body: JSON.stringify({ customer_id: "A001", nickname: "024-蜜茶" })
    }), env, {});
    assert.equal(response.status, 200);
    assert.equal(env.DB.database.prepare("SELECT address FROM customers WHERE id = 'A001'").get().address, "台北市信義路一段1號");
});

test("回歸：LINE- 暫存客戶編號不得被大寫化（那會變成偷改客戶編號）", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const tempId = customerRow(env).id;
    assert.match(tempId, /^LINE-[0-9a-f]+$/, "stableId 產生小寫 hex");
    const messageId = env.DB.database.prepare("SELECT message_id FROM line_order_inbox LIMIT 1").get().message_id;
    const response = await fetchHandler(new Request(`https://worker/api/line-inbox/${encodeURIComponent(messageId)}/bind-customer`, {
        method: "POST", headers: AUTH, body: JSON.stringify({ customer_id: tempId, nickname: "024-蜜茶" })
    }), env, {});
    assert.equal(response.status, 200, await response.text());
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1, "不得因大寫化而多出一筆客戶");
    assert.equal(customerRow(env).id, tempId);
    assert.equal(customerRow(env).custom_display_name, "024-蜜茶");
});

// --- migration-008：客戶備註（本名）跨裝置保存 ---

test("migration-008 可由 migration-007 後的 schema 安全升級（additive，不動既有資料）", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE customers (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, line_display_name TEXT, custom_display_name TEXT,
            line_user_id TEXT UNIQUE, pickup_type TEXT, address TEXT,
            profile_status TEXT NOT NULL DEFAULT 'complete', created_at TEXT, updated_at TEXT);
        INSERT INTO customers (id, nickname, custom_display_name, line_display_name, line_user_id, pickup_type, address, profile_status)
            VALUES ('A001', '024-蜜茶', '024-蜜茶', '蜜茶', 'U2', '外送', '台北市信義路一段1號', 'complete');
        INSERT INTO customers (id, nickname, profile_status) VALUES ('A002', '陳小明', 'complete');
    `);
    db.exec(fs.readFileSync(path.join(__dirname, "..", "migration-008-customer-notes.sql"), "utf8"));
    const bound = db.prepare("SELECT * FROM customers WHERE id = 'A001'").get();
    assert.equal(bound.notes, null, "新欄位可為空，不做回填");
    assert.equal(bound.custom_display_name, "024-蜜茶", "既有欄位不得被動到");
    assert.equal(bound.line_display_name, "蜜茶");
    assert.equal(bound.line_user_id, "U2");
    assert.equal(bound.pickup_type, "外送");
    assert.equal(bound.address, "台北市信義路一段1號");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 2, "不得刪除或新增資料列");
    // 升級後才能寫入備註
    db.prepare("UPDATE customers SET notes = ? WHERE id = 'A002'").run("常買紅茶，通常自取");
    assert.equal(db.prepare("SELECT notes FROM customers WHERE id = 'A002'").get().notes, "常買紅茶，通常自取");
    db.close();
});

test("migration-008：PUT /api/customers 要把備註存進 D1，GET 要回傳（跨裝置保存）", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    assert.equal(customerRow(env).notes, null, "LINE 事件不得寫備註");

    const saved = await putCustomer(env, customerId, { nickname: "024-蜜茶", notes: "本名：陳蜜茶，外送放管理室" });
    assert.equal(saved.status, 200, await saved.text());
    assert.equal(customerRow(env).notes, "本名：陳蜜茶，外送放管理室");
    assert.equal(customerRow(env).custom_display_name, "024-蜜茶");

    // 單筆 GET 與清單 GET 都要看得到（前端 syncCustomersFromCloud 讀清單）
    const one = await (await fetchHandler(new Request(`https://worker/api/customers/${encodeURIComponent(customerId)}`, { headers: AUTH }), env, {})).json();
    assert.equal(one.notes, "本名：陳蜜茶，外送放管理室");
    const listed = await (await fetchHandler(new Request("https://worker/api/customers", { headers: AUTH }), env, {})).json();
    assert.equal(listed.find(r => r.id === customerId).notes, "本名：陳蜜茶，外送放管理室");
});

test("migration-008：沒帶 notes 的部分更新不得清掉備註；帶空字串才是清空", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    await putCustomer(env, customerId, { nickname: "024-蜜茶", notes: "常客" });
    // 只更新取貨方式（前端「地址留空就不帶」的那種部分更新）→ 備註必須留著
    await putCustomer(env, customerId, { pickup_type: "自取" });
    assert.equal(customerRow(env).notes, "常客", "部分更新不得把備註洗掉");
    assert.equal(customerRow(env).pickup_type, "自取");
    // 團主真的把備註欄清空 → 帶空字串 → 清成 NULL
    await putCustomer(env, customerId, { nickname: "024-蜜茶", notes: "" });
    assert.equal(customerRow(env).notes, null);
    assert.equal(customerRow(env).custom_display_name, "024-蜜茶", "清備註不可影響名稱");
});

test("migration-008：備註前後空白要 trim、超過 500 字截斷（不擋存檔）", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "蜜茶", 2);
    const customerId = customerRow(env).id;
    await putCustomer(env, customerId, { notes: "  兩側空白  " });
    assert.equal(customerRow(env).notes, "兩側空白");
    const tooLong = await putCustomer(env, customerId, { notes: "備".repeat(600) });
    assert.equal(tooLong.status, 200, "過長不擋存檔，只截斷");
    assert.equal(customerRow(env).notes.length, 500);
});

test("migration-008：舊客戶（notes 為 NULL）照樣載入，只改名稱不會弄出 undefined 備註", async () => {
    const env = createEnv();
    env.DB.database.prepare(`INSERT INTO customers (id, nickname, custom_display_name, line_display_name, profile_status)
        VALUES ('A001', '陳小明', '001-陳小明', '陳小明', 'complete')`).run();
    const listed = await (await fetchHandler(new Request("https://worker/api/customers", { headers: AUTH }), env, {})).json();
    assert.equal(listed[0].notes, null, "舊客戶備註是 null，不可爆錯");
    assert.equal(listed[0].customer_display_name, "001-陳小明");
    const saved = await putCustomer(env, "A001", { nickname: "001-陳小明（VIP）" });
    assert.equal(saved.status, 200);
    const row = env.DB.database.prepare("SELECT * FROM customers WHERE id = 'A001'").get();
    assert.equal(row.notes, null, "沒帶 notes 就維持 NULL，不可寫進 'undefined'");
    assert.equal(row.custom_display_name, "001-陳小明（VIP）");
});

test("migration-008：新客戶（PUT 建檔）第一次就可帶備註", async () => {
    const env = createEnv();
    const saved = await putCustomer(env, "A009", { nickname: "009-阿賢", notes: "本名：王大賢" });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.customer.notes, "本名：王大賢", "回傳的 customer 也要帶 notes");
    const row = env.DB.database.prepare("SELECT * FROM customers WHERE id = 'A009'").get();
    assert.equal(row.notes, "本名：王大賢");
    assert.equal(row.custom_display_name, "009-阿賢");
    assert.equal(row.nickname, "009-阿賢");
    assert.equal(row.line_user_id, null);
});
