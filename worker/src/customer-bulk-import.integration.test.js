// 客戶「快速貼上匯入」批次匯入端到端驗收（node:sqlite 當 D1 shim）。
// 重點保護：
//   1. 客戶編號是字串（"001" 不可變成 1、前導零不可掉）
//   2. 已存在的客戶預設略過，不可重複寫入
//   3. mode="update" 只改名稱三欄，line_user_id／pickup_type／address／profile_status 不得被動到
//      （否則 LINE 綁定會斷、LIFF 填的地址會消失、訂單會找不到客戶）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { fetch: fetchHandler } = require("./index.js");
const { parseCustomerPaste } = require("../../customer-paste-parse.js");

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
    return { ADMIN_API_KEY: "secret", DB };
}

const AUTH = { authorization: "Bearer secret", "content-type": "application/json" };

async function bulkImport(env, items, headers = AUTH) {
    const response = await fetchHandler(new Request("https://worker/api/customers/bulk-import", {
        method: "POST", headers, body: JSON.stringify({ items })
    }), env, {});
    return { status: response.status, body: await response.json() };
}

function rowsOf(env) {
    return env.DB.database.prepare("SELECT * FROM customers ORDER BY id").all();
}

// 貼上文字 → 解析 → 送出，模擬前端完整流程
function itemsFromPaste(text, modeById = {}) {
    return parseCustomerPaste(text).rows
        .filter(row => row.status === "ok")
        .map(row => ({ id: row.code, name: row.name, lineName: row.lineName, mode: modeById[row.code] || "skip" }));
}

test("未帶管理金鑰一律 401，不得寫入", async () => {
    const env = createEnv();
    const result = await bulkImport(env, [{ id: "001", name: "蔡清景", lineName: "蔡清景" }], { "content-type": "application/json" });
    assert.equal(result.status, 401);
    assert.equal(rowsOf(env).length, 0);
});

test("首次匯入：新增客戶，編號保持字串且名稱寫進三個欄位", async () => {
    const env = createEnv();
    const text = [
        "001號蔡清景 - 蔡清景",
        "002號鄭雅蘭 - 鄭雅蘭",
        "004號陳美娟-陳美娟",
        "005號家玲-小葉娃",
        "006洪敏玲-洪敏玲"
    ].join("\n");
    const result = await bulkImport(env, itemsFromPaste(text));
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(
        [result.body.created, result.body.updated, result.body.skipped, result.body.failed],
        [5, 0, 0, 0]
    );

    const rows = rowsOf(env);
    assert.deepEqual(rows.map(r => r.id), ["001", "002", "004", "005", "006"]);
    assert.equal(typeof rows[0].id, "string", "客戶編號必須是字串，不可被轉成數字");
    assert.equal(rows[0].id, "001");
    assert.equal(rows[0].custom_display_name, "蔡清景");
    assert.equal(rows[0].line_display_name, "蔡清景");
    assert.equal(rows[0].nickname, "蔡清景", "nickname 是 NOT NULL 且要鏡射顯示名稱");
    assert.equal(rows[0].profile_status, "complete");
    assert.equal(rows[0].line_user_id, null);
    // 005 的姓名與 LINE 名稱不同
    const row005 = rows.find(r => r.id === "005");
    assert.equal(row005.custom_display_name, "家玲");
    assert.equal(row005.line_display_name, "小葉娃");

    // GET /api/customers 也要看得到（顯示名稱以團主設定名稱為準）
    const listed = await (await fetchHandler(new Request("https://worker/api/customers", { headers: AUTH }), env, {})).json();
    assert.equal(listed.length, 5);
    assert.equal(listed.find(r => r.id === "005").customer_display_name, "家玲");
});

test("重複匯入同一份名單：預設略過，不會重複寫入", async () => {
    const env = createEnv();
    const text = "001號蔡清景 - 蔡清景\n002號鄭雅蘭 - 鄭雅蘭";
    await bulkImport(env, itemsFromPaste(text));
    const again = await bulkImport(env, itemsFromPaste(text));
    assert.deepEqual(
        [again.body.created, again.body.updated, again.body.skipped, again.body.failed],
        [0, 0, 2, 0]
    );
    assert.equal(rowsOf(env).length, 2, "不可產生第二筆同編號客戶");
    assert.ok(again.body.details.every(d => d.action === "skipped"));
    assert.match(again.body.details[0].note, /客戶編號已存在/);
});

test("略過時要回報差異內容", async () => {
    const env = createEnv();
    await bulkImport(env, [{ id: "005", name: "家玲", lineName: "小葉娃", mode: "skip" }]);
    const again = await bulkImport(env, [{ id: "005", name: "家玲玲", lineName: "小葉娃娃", mode: "skip" }]);
    assert.equal(again.body.skipped, 1);
    assert.match(again.body.details[0].note, /家玲/);
    assert.match(again.body.details[0].note, /小葉娃娃/);
    const row = rowsOf(env)[0];
    assert.equal(row.custom_display_name, "家玲", "略過就是不寫入");
    assert.equal(row.line_display_name, "小葉娃");
});

test("同一批資料裡出現重複編號，只處理第一筆（不可整批 rollback）", async () => {
    const env = createEnv();
    const result = await bulkImport(env, [
        { id: "001", name: "蔡清景", lineName: "蔡清景" },
        { id: "001", name: "蔡清景2", lineName: "蔡清景2" }
    ]);
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.created, result.body.skipped], [1, 1]);
    const rows = rowsOf(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].custom_display_name, "蔡清景");
});

test("mode=update：只更新名稱，line_user_id／pickup_type／address／profile_status 不得被動到", async () => {
    const env = createEnv();
    // 模擬一個已經綁好 LINE、在 LIFF 填過地址的既有客戶
    env.DB.database.prepare(`INSERT INTO customers
        (id, nickname, custom_display_name, line_display_name, line_user_id, pickup_type, address, profile_status, created_at, updated_at)
        VALUES ('005', '舊名字', '舊名字', '舊LINE名', 'U-MICHA', '外送', '台北市信義區信義路五段7號', 'complete', '2026-01-01', '2026-01-01')`).run();
    const orderTable = env.DB.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'").get();
    assert.ok(orderTable, "schema 需含 orders 表");
    env.DB.database.prepare(`INSERT INTO line_order_inbox
        (message_id, group_id, raw_message, normalized_message, message_time, status)
        VALUES ('MSG-1', 'G1', 'P1 1', 'P1 1', '2026-07-22T10:00:00Z', '已轉正式訂單')`).run();
    env.DB.database.prepare("INSERT INTO orders (id, source_message_id, customer_id, status) VALUES ('ORD-1', 'MSG-1', '005', '新訂單')").run();

    const result = await bulkImport(env, [{ id: "005", name: "家玲", lineName: "小葉娃", mode: "update" }]);
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.created, result.body.updated, result.body.skipped], [0, 1, 0]);

    const row = rowsOf(env)[0];
    assert.equal(row.custom_display_name, "家玲");
    assert.equal(row.line_display_name, "小葉娃");
    assert.equal(row.nickname, "家玲");
    assert.equal(row.line_user_id, "U-MICHA", "LINE 綁定不可被動到");
    assert.equal(row.pickup_type, "外送", "取貨方式不可被動到");
    assert.equal(row.address, "台北市信義區信義路五段7號", "LIFF 填的地址不可被清掉");
    assert.equal(row.profile_status, "complete");
    assert.notEqual(row.updated_at, "2026-01-01", "updated_at 要更新");

    // 訂單↔客戶關聯不受影響
    const order = env.DB.database.prepare("SELECT * FROM orders WHERE id = 'ORD-1'").get();
    assert.equal(order.customer_id, "005");
});

test("既有 A001 系列客戶不受影響，新的 001 是另一組編號", async () => {
    const env = createEnv();
    env.DB.database.prepare(`INSERT INTO customers (id, nickname, profile_status) VALUES ('A001', '既有客戶', 'complete')`).run();
    const result = await bulkImport(env, [{ id: "001", name: "蔡清景", lineName: "蔡清景" }]);
    assert.equal(result.body.created, 1);
    const rows = rowsOf(env);
    assert.deepEqual(rows.map(r => r.id), ["001", "A001"]);
    assert.equal(rows.find(r => r.id === "A001").nickname, "既有客戶");
});

test("伺服器端驗證：空編號／空姓名／過長一律不寫入並回報", async () => {
    const env = createEnv();
    const result = await bulkImport(env, [
        { id: "", name: "沒有編號", lineName: "沒有編號" },
        { id: "003", name: "   ", lineName: "空姓名" },
        { id: "x".repeat(33), name: "編號過長", lineName: "編號過長" },
        { id: "004", name: "名".repeat(101), lineName: "名字過長" },
        { id: "005", name: "家玲", lineName: "娃".repeat(101) },
        null,
        { id: "006", name: "洪敏玲", lineName: "洪敏玲" }
    ]);
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.created, result.body.failed], [1, 6]);
    const rows = rowsOf(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "006");
    // 錯誤訊息一律中文，且不得洩漏 SQL／stack
    for (const detail of result.body.details.filter(d => d.action === "failed")) {
        assert.ok(detail.note && detail.note.length > 0);
        assert.doesNotMatch(detail.note, /INSERT|SELECT|SQLITE|at Object|\.js:/i);
    }
});

test("items 不是陣列／空陣列／超量 → 400 中文錯誤", async () => {
    const env = createEnv();
    const notArray = await fetchHandler(new Request("https://worker/api/customers/bulk-import", {
        method: "POST", headers: AUTH, body: JSON.stringify({ items: "001" })
    }), env, {});
    assert.equal(notArray.status, 400);
    assert.equal((await notArray.json()).error, "JSON 格式錯誤");

    const empty = await bulkImport(env, []);
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "沒有可匯入的資料");

    const tooMany = await bulkImport(env, Array.from({ length: 501 }, (_value, index) => ({
        id: String(index + 1).padStart(3, "0"), name: `客戶${index}`, lineName: `客戶${index}`
    })));
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /一次最多匯入 500 筆/);
    assert.equal(rowsOf(env).length, 0);
});

test("混合：新增＋略過＋更新＋錯誤可同時處理，統計數字要對", async () => {
    const env = createEnv();
    await bulkImport(env, [
        { id: "001", name: "蔡清景", lineName: "蔡清景" },
        { id: "002", name: "鄭雅蘭", lineName: "鄭雅蘭" }
    ]);
    const result = await bulkImport(env, [
        { id: "001", name: "蔡清景", lineName: "蔡清景", mode: "skip" },
        { id: "002", name: "鄭雅蘭改", lineName: "小蘭", mode: "update" },
        { id: "004", name: "陳美娟", lineName: "陳美娟", mode: "skip" },
        { id: "005", name: "", lineName: "小葉娃", mode: "skip" }
    ]);
    assert.deepEqual(
        [result.body.created, result.body.updated, result.body.skipped, result.body.failed],
        [1, 1, 1, 1]
    );
    assert.deepEqual(result.body.details.map(d => d.action), ["skipped", "updated", "created", "failed"]);
    const rows = rowsOf(env);
    assert.deepEqual(rows.map(r => r.id), ["001", "002", "004"]);
    assert.equal(rows.find(r => r.id === "002").custom_display_name, "鄭雅蘭改");
    assert.equal(rows.find(r => r.id === "002").line_display_name, "小蘭");
});

test("LINE 名稱留空時沿用姓名", async () => {
    const env = createEnv();
    await bulkImport(env, [{ id: "007", name: "王小明", lineName: "" }]);
    const row = rowsOf(env)[0];
    assert.equal(row.custom_display_name, "王小明");
    assert.equal(row.line_display_name, "王小明");
});
