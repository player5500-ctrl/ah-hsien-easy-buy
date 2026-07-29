// 一位客戶多個 LINE 帳號（migration-010：customer_line_accounts）端到端驗收：
//   真實案例：蜜茶（A001／024-蜜茶）用兩個 LINE 帳號下單，兩個帳號都必須解析到 A001。
//   查找規則：先查 customer_line_accounts，再回退 legacy customers.line_user_id；
//   綁定規則：bind-customer 是「新增帳號」不是「換綁」，legacy 欄位只在還沒有帳號時才填；
//   容錯規則：對照表還沒建（migration-010 未套用）時，一切退回舊行為，Worker 不得爆錯。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { fetch: fetchHandler, processPostback, createDependencies } = require("./index.js");
const Liff = require("./liff.js");

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

function postback(env, webhookEventId, lineUserId, displayName, quantity) {
    return processPostback(env, {
        webhookEventId,
        timestamp: Date.parse("2026-07-22T10:00:00Z"),
        groupId: "G1",
        lineUserId,
        displayName,
        data: new URLSearchParams({ action: "set_quantity", groupBuyId: "GB1", productId: "P1", quantity: String(quantity) }).toString()
    });
}

// 建立「已綁第一個帳號」的正式客戶：legacy 欄位＋對照表各一列（migration-010 回填後的狀態）。
function seedBoundCustomer(env, id, lineUserId, customName, lineName) {
    env.DB.database.prepare(`INSERT INTO customers
        (id, nickname, custom_display_name, line_display_name, line_user_id, profile_status)
        VALUES (?, ?, ?, ?, ?, 'complete')`).run(id, customName, customName, lineName, lineUserId);
    env.DB.database.prepare(`INSERT INTO customer_line_accounts (line_user_id, customer_id, line_display_name)
        VALUES (?, ?, ?)`).run(lineUserId, id, lineName);
}

async function bindInbox(env, messageId, customerId, nickname) {
    return fetchHandler(new Request(`https://worker/api/line-inbox/${encodeURIComponent(messageId)}/bind-customer`, {
        method: "POST", headers: AUTH, body: JSON.stringify({ customer_id: customerId, nickname })
    }), env, {});
}

async function liffSetQuantity(env, sub, name, quantity) {
    const original = Liff.verifyLineIdToken;
    Liff.verifyLineIdToken = async () => ({ sub, name });
    try {
        return await Liff.handleLiffRoutes(
            new Request("https://worker/api/liff/orders/set-quantity", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ idToken: "t", groupBuyId: "GB1", productId: "P1", quantity, pickupType: "自取" })
            }), env, new URL("https://worker/api/liff/orders/set-quantity"));
    } finally {
        Liff.verifyLineIdToken = original;
    }
}

test("migration-010：可由 migration-008 時代的 DB 安全升級並回填既有綁定，可重跑", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE customers (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, line_display_name TEXT, custom_display_name TEXT,
            line_user_id TEXT UNIQUE, pickup_type TEXT, address TEXT,
            profile_status TEXT NOT NULL DEFAULT 'complete', created_at TEXT, updated_at TEXT, notes TEXT);
        INSERT INTO customers (id, nickname, custom_display_name, line_display_name, line_user_id, profile_status)
            VALUES ('A001', '024-蜜茶', '024-蜜茶', '蜜茶', 'U229f8d', 'complete');
        INSERT INTO customers (id, nickname, line_display_name, line_user_id, profile_status)
            VALUES ('LINE-f3f2736692567685a954e42d', '蜜茶2號', '蜜茶2號', 'Ubb586a', 'pending');
        INSERT INTO customers (id, nickname, profile_status) VALUES ('A002', '陳小明', 'complete');
    `);
    const migration = fs.readFileSync(path.join(__dirname, "..", "migration-010-customer-line-accounts.sql"), "utf8");
    db.exec(migration);
    const accounts = db.prepare("SELECT * FROM customer_line_accounts ORDER BY line_user_id").all();
    assert.equal(accounts.length, 2, "只回填有 line_user_id 的客戶");
    assert.deepEqual(accounts.map(row => [row.line_user_id, row.customer_id, row.line_display_name]), [
        ["U229f8d", "A001", "蜜茶"],
        ["Ubb586a", "LINE-f3f2736692567685a954e42d", "蜜茶2號"]
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 3, "不得刪除或新增客戶列");
    assert.equal(db.prepare("SELECT line_user_id FROM customers WHERE id = 'A001'").get().line_user_id, "U229f8d", "legacy 欄位保留不動");
    assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version = '010'").get());
    // 可安全重跑（INSERT OR IGNORE／IF NOT EXISTS）
    db.exec(migration);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customer_line_accounts").get().c, 2);
    db.close();
});

test("Postback：對照表綁定的第二帳號解析到正式客戶，不建暫存客戶、legacy 欄位不動", async () => {
    const env = createEnv();
    seedBoundCustomer(env, "A001", "U1", "024-蜜茶", "蜜茶");
    env.DB.database.prepare("INSERT INTO customer_line_accounts (line_user_id, customer_id) VALUES ('U2', 'A001')").run();

    const result = await postback(env, "evt-u2", "U2", "蜜茶小號", 3);
    assert.equal(result.processed, true);
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1, "不得建立 LINE- 暫存客戶");
    const order = env.DB.database.prepare("SELECT customer_id FROM orders").get();
    assert.equal(order.customer_id, "A001", "第二帳號的訂單落在正式客戶");
    const customer = env.DB.database.prepare("SELECT * FROM customers WHERE id = 'A001'").get();
    assert.equal(customer.line_user_id, "U1", "legacy 欄位（第一個帳號）不得被覆蓋");
    assert.equal(customer.custom_display_name, "024-蜜茶", "團主自訂名稱不得被覆蓋");
    // 第二帳號的 LINE 名稱記在對照列，不動 customers.line_display_name
    assert.equal(env.DB.database.prepare("SELECT line_display_name FROM customer_line_accounts WHERE line_user_id = 'U2'").get().line_display_name, "蜜茶小號");
    assert.equal(customer.line_display_name, "蜜茶");
});

test("Postback：未知帳號仍自動建立 LINE- 暫存客戶並寫入對照列", async () => {
    const env = createEnv();
    const result = await postback(env, "evt-new", "U-NEW", "新客人", 1);
    assert.equal(result.processed, true);
    const customer = env.DB.database.prepare("SELECT * FROM customers").get();
    assert.match(customer.id, /^LINE-[0-9a-f]+$/);
    assert.equal(customer.line_user_id, "U-NEW", "暫存客戶照舊填 legacy 欄位");
    const account = env.DB.database.prepare("SELECT * FROM customer_line_accounts WHERE line_user_id = 'U-NEW'").get();
    assert.equal(account.customer_id, customer.id, "同一批要寫入對照列");
    assert.equal(account.line_display_name, "新客人");
});

test("Postback：legacy 舊資料（只有 customers.line_user_id、無對照列）仍可解析，摸到就回填對照列", async () => {
    const env = createEnv();
    env.DB.database.prepare(`INSERT INTO customers (id, nickname, line_user_id, profile_status)
        VALUES ('C1', '文字客戶', 'ULEG', 'complete')`).run();
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customer_line_accounts").get().c, 0);
    const result = await postback(env, "evt-leg", "ULEG", "文字客戶", 2);
    assert.equal(result.processed, true);
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1, "不得建第二筆客戶");
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM orders").get().customer_id, "C1");
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM customer_line_accounts WHERE line_user_id = 'ULEG'").get().customer_id, "C1", "摸到就回填");
});

test("LIFF：第二帳號經對照表解析，訂單落在正式客戶（不建暫存客戶）", async () => {
    const env = createEnv();
    seedBoundCustomer(env, "A001", "U1", "024-蜜茶", "蜜茶");
    env.DB.database.prepare("INSERT INTO customer_line_accounts (line_user_id, customer_id) VALUES ('U2', 'A001')").run();
    const response = await liffSetQuantity(env, "U2", "蜜茶小號", 4);
    assert.equal(response.status, 200, await response.text());
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1);
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM orders").get().customer_id, "A001");
    assert.equal(env.DB.database.prepare("SELECT line_user_id FROM customers WHERE id = 'A001'").get().line_user_id, "U1");
    assert.equal(env.DB.database.prepare("SELECT custom_display_name FROM customers WHERE id = 'A001'").get().custom_display_name, "024-蜜茶");
});

test("LIFF：對照表沒有資料時回退 legacy customers.line_user_id（舊資料相容）", async () => {
    const env = createEnv();
    env.DB.database.prepare(`INSERT INTO customers (id, nickname, line_user_id, address, profile_status)
        VALUES ('C1', '文字客戶', 'ULEG', '台北市信義路一段1號', 'complete')`).run();
    const response = await liffSetQuantity(env, "ULEG", "文字客戶", 2);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.order.address, "台北市信義路一段1號", "resolveCustomer 要帶回客戶地址");
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM orders").get().customer_id, "C1");
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1);
});

test("綁定：已有帳號的客戶可再綁第二個帳號，兩個帳號都解析到他、legacy 欄位不動", async () => {
    const env = createEnv();
    seedBoundCustomer(env, "A001", "U229f8d", "024-蜜茶", "蜜茶");
    // 蜜茶用第二個帳號下單 → 自動建立暫存客戶＋訂單
    await postback(env, "evt-2nd", "Ubb586a", "蜜茶2號", 2);
    const pending = env.DB.database.prepare("SELECT id FROM customers WHERE id LIKE 'LINE-%'").get();
    assert.ok(pending, "第二帳號先被建成暫存客戶");
    const messageId = env.DB.database.prepare("SELECT message_id FROM line_order_inbox LIMIT 1").get().message_id;

    const response = await bindInbox(env, messageId, "A001", "024-蜜茶");
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.line_accounts_count, 2, "綁定回應要回報帳號數");

    const customer = env.DB.database.prepare("SELECT * FROM customers WHERE id = 'A001'").get();
    assert.equal(customer.line_user_id, "U229f8d", "legacy 欄位維持第一個帳號，不得被第二個帳號覆蓋");
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1, "暫存客戶已合併移除");
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM customer_line_accounts WHERE line_user_id = 'Ubb586a'").get().customer_id, "A001");
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM customer_line_accounts WHERE line_user_id = 'U229f8d'").get().customer_id, "A001");

    // 兩個帳號之後的留言／商品卡都要解析到 A001
    const dependencies = createDependencies(env);
    assert.equal((await dependencies.findCustomer("U229f8d", "蜜茶")).id, "A001");
    assert.equal((await dependencies.findCustomer("Ubb586a", "蜜茶2號")).id, "A001");
    const again = await postback(env, "evt-2nd-again", "Ubb586a", "蜜茶2號", 5);
    assert.equal(again.processed, true);
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1, "綁定後第二帳號不得再生暫存客戶");
});

test("綁定：暫存客戶的訂單移轉、暫存列與其對照列一併刪除", async () => {
    const env = createEnv();
    await postback(env, "evt-1", "U-TEMP", "蜜茶", 2);
    const pendingId = env.DB.database.prepare("SELECT id FROM customers").get().id;
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM customer_line_accounts WHERE line_user_id = 'U-TEMP'").get().customer_id, pendingId);
    const messageId = env.DB.database.prepare("SELECT message_id FROM line_order_inbox LIMIT 1").get().message_id;

    const response = await bindInbox(env, messageId, "A001", "024-蜜茶");
    assert.equal(response.status, 200, await response.text());
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers WHERE id = ?").get(pendingId).c, 0, "暫存客戶已刪除");
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM orders").get().customer_id, "A001", "訂單已移轉");
    const accounts = env.DB.database.prepare("SELECT * FROM customer_line_accounts").all();
    assert.equal(accounts.length, 1, "暫存客戶的對照列不得殘留");
    assert.deepEqual([accounts[0].line_user_id, accounts[0].customer_id], ["U-TEMP", "A001"]);
    assert.equal(env.DB.database.prepare("SELECT line_user_id FROM customers WHERE id = 'A001'").get().line_user_id, "U-TEMP", "第一個帳號填入 legacy 欄位");
});

test("綁定：同一團購兩邊都有訂單時維持 409，且不得留下半套資料", async () => {
    const env = createEnv();
    seedBoundCustomer(env, "A001", "U1", "024-蜜茶", "蜜茶");
    await postback(env, "evt-a001", "U1", "蜜茶", 1);
    await postback(env, "evt-temp", "U2", "蜜茶2號", 2);
    const pendingId = env.DB.database.prepare("SELECT id FROM customers WHERE id LIKE 'LINE-%'").get().id;
    const messageId = env.DB.database.prepare("SELECT message_id FROM line_order_inbox WHERE line_user_id = 'U2' LIMIT 1").get().message_id;

    const response = await bindInbox(env, messageId, "A001", "024-蜜茶");
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /同一團購已有訂單/);
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers WHERE id = ?").get(pendingId).c, 1, "暫存客戶保留（rollback）");
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM customer_line_accounts WHERE line_user_id = 'U2'").get().customer_id, pendingId, "對照列保留（rollback）");
});

test("GET /api/customers：回傳 line_accounts_count（綁定帳號數），既有欄位不變", async () => {
    const env = createEnv();
    seedBoundCustomer(env, "A001", "U1", "024-蜜茶", "蜜茶");
    env.DB.database.prepare("INSERT INTO customer_line_accounts (line_user_id, customer_id) VALUES ('U2', 'A001')").run();
    env.DB.database.prepare("INSERT INTO customers (id, nickname, profile_status) VALUES ('A002', '陳小明', 'complete')").run();

    const listed = await (await fetchHandler(new Request("https://worker/api/customers", { headers: AUTH }), env, {})).json();
    const a001 = listed.find(row => row.id === "A001");
    assert.equal(a001.line_accounts_count, 2);
    assert.equal(a001.customer_display_name, "024-蜜茶", "既有欄位照舊");
    assert.equal(a001.line_user_id, "U1");
    assert.equal(listed.find(row => row.id === "A002").line_accounts_count, 0);
    // 單筆 GET 也帶同一欄（客戶編輯視窗用）
    const one = await (await fetchHandler(new Request("https://worker/api/customers/A001", { headers: AUTH }), env, {})).json();
    assert.equal(one.line_accounts_count, 2);
});

test("唯一性：同一 LINE 帳號不得同時指向兩位客戶；改綁到另一位正式客戶要 409", async () => {
    const env = createEnv();
    seedBoundCustomer(env, "A001", "U1", "024-蜜茶", "蜜茶");
    env.DB.database.prepare("INSERT INTO customers (id, nickname, profile_status) VALUES ('A002', '陳小明', 'complete')").run();
    // PRIMARY KEY 擋掉第二位擁有者
    assert.throws(() => env.DB.database.prepare("INSERT INTO customer_line_accounts (line_user_id, customer_id) VALUES ('U1', 'A002')").run(),
        /UNIQUE|PRIMARY/i);
    // ON CONFLICT DO UPDATE 才能搬 customer_id（bind-customer 專用語意）
    env.DB.database.prepare(`INSERT INTO customer_line_accounts (line_user_id, customer_id)
        VALUES ('U1', 'A002') ON CONFLICT(line_user_id) DO UPDATE SET customer_id = excluded.customer_id`).run();
    assert.equal(env.DB.database.prepare("SELECT customer_id FROM customer_line_accounts WHERE line_user_id = 'U1'").get().customer_id, "A002");
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customer_line_accounts WHERE line_user_id = 'U1'").get().c, 1);

    // 端點層：帳號已屬於別的「正式」客戶 → 409（不得自動改綁）
    const env2 = createEnv();
    seedBoundCustomer(env2, "A001", "U1", "024-蜜茶", "蜜茶");
    env2.DB.database.prepare("INSERT INTO customers (id, nickname, profile_status) VALUES ('A002', '陳小明', 'complete')").run();
    env2.DB.database.prepare(`INSERT INTO line_order_inbox
        (message_id, group_id, line_user_id, display_name, raw_message, normalized_message, message_time, status)
        VALUES ('M1', 'G1', 'U1', '蜜茶', 'P1+1', 'P1+1', '2026-07-22T10:00:00.000Z', '待配對客戶')`).run();
    const response = await bindInbox(env2, "M1", "A002", "002-陳小明");
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /已綁定客戶 A001/);
});

test("容錯：customer_line_accounts 表不存在（migration-010 未套用）時全部退回舊行為", async () => {
    const env = createEnv();
    env.DB.database.exec("DROP TABLE customer_line_accounts");

    // Postback 照舊建暫存客戶
    const result = await postback(env, "evt-1", "U-MICHA", "蜜茶", 2);
    assert.equal(result.processed, true);
    const pending = env.DB.database.prepare("SELECT * FROM customers").get();
    assert.match(pending.id, /^LINE-/);
    assert.equal(pending.line_user_id, "U-MICHA");

    // LIFF 照舊解析同一位暫存客戶
    const liffResponse = await liffSetQuantity(env, "U-MICHA", "蜜茶", 3);
    assert.equal(liffResponse.status, 200, await liffResponse.text());
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1);

    // 客戶清單照舊可讀（沒有 line_accounts_count 欄）
    const listed = await (await fetchHandler(new Request("https://worker/api/customers", { headers: AUTH }), env, {})).json();
    assert.equal(listed.length, 1);
    assert.equal("line_accounts_count" in listed[0], false);

    // 綁定退回舊行為：直接覆蓋 legacy 欄位（一客一帳號）
    const messageId = env.DB.database.prepare("SELECT message_id FROM line_order_inbox LIMIT 1").get().message_id;
    const bound = await bindInbox(env, messageId, "A001", "024-蜜茶");
    const boundBody = await bound.json();
    assert.equal(bound.status, 200, JSON.stringify(boundBody));
    assert.equal(boundBody.line_accounts_count, null);
    assert.equal(env.DB.database.prepare("SELECT line_user_id FROM customers WHERE id = 'A001'").get().line_user_id, "U-MICHA");
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 1);
});

test("刪除客戶：連同對照列一併刪除，不得因外鍵爆 500", async () => {
    const env = createEnv();
    seedBoundCustomer(env, "A001", "U1", "024-蜜茶", "蜜茶");
    env.DB.database.prepare("INSERT INTO customer_line_accounts (line_user_id, customer_id) VALUES ('U2', 'A001')").run();
    const response = await fetchHandler(new Request("https://worker/api/customers/A001", { method: "DELETE", headers: AUTH }), env, {});
    assert.equal(response.status, 200, await response.text());
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 0);
    assert.equal(env.DB.database.prepare("SELECT COUNT(*) AS c FROM customer_line_accounts").get().c, 0, "對照列不得殘留");
});
