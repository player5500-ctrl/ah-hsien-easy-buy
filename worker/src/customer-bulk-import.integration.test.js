// 客戶「快速貼上匯入」批次匯入端到端驗收（node:sqlite 當 D1 shim）。
//
// 保護的既有慣例（2026-07-28 對照 production 前 7 筆客戶確認）：
//   customers.id        = 系統自動配號 A00N（接續現有最大 A### 往下發），貼上的 001 不是 id
//   custom_display_name = `<編號>-<LINE暱稱>`，例：005-小葉娃
//   line_display_name   = LINE 暱稱（LINE 訊息比對靠這欄）
//   nickname            = 本名（NOT NULL）
//
// 重點保護：
//   1. 配號要接續（A007 之後是 A008），同一批要連號，不可撞 PRIMARY KEY
//   2. 「已存在」看 custom_display_name 的 `<編號>-` 前綴，不是看 id
//   3. 編號是字串（"001" 不可變成 1、前導零不可掉）
//   4. mode="update" 只改名稱三欄，line_user_id／pickup_type／address／profile_status 不得被動到
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
function itemsFromPaste(text, modeByCode = {}) {
    return parseCustomerPaste(text).rows
        .filter(row => row.status === "ok")
        .map(row => ({ code: row.code, name: row.name, lineName: row.lineName, mode: modeByCode[row.code] || "skip" }));
}

// 模擬 Vanny 手動建好的既有客戶（A001…A007）
function seedExistingCustomers(env, entries) {
    for (const [id, code, name, lineName] of entries) {
        env.DB.database.prepare(`INSERT INTO customers
            (id, nickname, custom_display_name, line_display_name, profile_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'complete', '2026-07-01', '2026-07-01')`)
            .run(id, name, `${code}-${lineName}`, lineName);
    }
}

const SEED_A001_TO_A007 = [
    ["A001", "001", "蔡清景", "蔡清景"],
    ["A002", "002", "鄭雅蘭", "鄭雅蘭"],
    ["A003", "003", "王大明", "大明"],
    ["A004", "004", "陳美娟", "陳美娟"],
    ["A005", "005", "家玲", "小葉娃"],
    ["A006", "006", "洪敏玲", "洪敏玲"],
    ["A007", "007", "林小美", "小美"]
];

test("未帶管理金鑰一律 401，不得寫入", async () => {
    const env = createEnv();
    const result = await bulkImport(env, [{ code: "001", name: "蔡清景", lineName: "蔡清景" }], { "content-type": "application/json" });
    assert.equal(result.status, 401);
    assert.equal(rowsOf(env).length, 0);
});

test("空名冊首次匯入：從 A001 開始配號，欄位照既有慣例寫入", async () => {
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
    assert.deepEqual(rows.map(r => r.id), ["A001", "A002", "A003", "A004", "A005"], "沒有任何 A### 時從 A001 開始連號");
    assert.equal(typeof rows[0].id, "string");
    // 貼上的 001 只是顯示名稱前綴，不是 id
    assert.equal(rows[0].custom_display_name, "001-蔡清景");
    assert.equal(rows[0].line_display_name, "蔡清景");
    assert.equal(rows[0].nickname, "蔡清景", "nickname 是本名且 NOT NULL");
    assert.equal(rows[0].profile_status, "complete");
    assert.equal(rows[0].line_user_id, null);
    assert.equal(rows[0].address, null);
    // 005 的本名與 LINE 暱稱不同：顯示名稱要用 LINE 暱稱，nickname 用本名
    const micha = rows.find(r => r.custom_display_name === "005-小葉娃");
    assert.ok(micha, "005 應寫成 005-小葉娃");
    assert.equal(micha.id, "A004");
    assert.equal(micha.line_display_name, "小葉娃");
    assert.equal(micha.nickname, "家玲");

    // 回傳 details 要同時帶「貼上的編號」與「配到的 id」
    assert.deepEqual(result.body.details.map(d => d.code), ["001", "002", "004", "005", "006"]);
    assert.deepEqual(result.body.details.map(d => d.id), ["A001", "A002", "A003", "A004", "A005"]);
    assert.ok(result.body.details.every(d => d.action === "created"));

    // GET /api/customers 也要看得到（顯示名稱以 custom_display_name 為準）
    const listed = await (await fetchHandler(new Request("https://worker/api/customers", { headers: AUTH }), env, {})).json();
    assert.equal(listed.length, 5);
    assert.equal(listed.find(r => r.id === "A004").customer_display_name, "005-小葉娃");
});

test("配號接續既有最大號：A007 之後是 A008，同一批連號 A008／A009／A010", async () => {
    const env = createEnv();
    seedExistingCustomers(env, SEED_A001_TO_A007);
    const text = [
        "008號張三-張三",
        "009號李四-小四",
        "010號王五-阿五"
    ].join("\r\n");
    const result = await bulkImport(env, itemsFromPaste(text));
    assert.deepEqual([result.body.created, result.body.skipped, result.body.failed], [3, 0, 0]);
    assert.deepEqual(result.body.details.map(d => d.id), ["A008", "A009", "A010"]);

    const rows = rowsOf(env);
    assert.equal(rows.length, 10);
    assert.deepEqual(
        rows.filter(r => Number(r.id.slice(1)) >= 8).map(r => [r.id, r.custom_display_name, r.line_display_name, r.nickname]),
        [
            ["A008", "008-張三", "張三", "張三"],
            ["A009", "009-小四", "小四", "李四"],
            ["A010", "010-阿五", "阿五", "王五"]
        ]
    );
    // 既有 A001…A007 一個都不能被動到
    assert.equal(rows.find(r => r.id === "A005").custom_display_name, "005-小葉娃");
    assert.equal(rows.find(r => r.id === "A007").updated_at, "2026-07-01");
});

test("配號忽略非 A### 的 id（LINE-xxxx 暫存客戶不影響流水號）", async () => {
    const env = createEnv();
    env.DB.database.prepare(`INSERT INTO customers (id, nickname, profile_status) VALUES ('LINE-9f2a', 'LINE 訪客', 'pending')`).run();
    env.DB.database.prepare(`INSERT INTO customers (id, nickname, custom_display_name, line_display_name, profile_status)
        VALUES ('A003', '既有客戶', '003-既有客戶', '既有客戶', 'complete')`).run();
    const result = await bulkImport(env, [{ code: "011", name: "張三", lineName: "張三" }]);
    assert.equal(result.body.details[0].id, "A004", "最大 A### 是 A003，下一號就是 A004");
    assert.equal(rowsOf(env).find(r => r.id === "LINE-9f2a").nickname, "LINE 訪客");
});

test("配號破百也要接對（字典序陷阱：A1000 不可小於 A999）", async () => {
    const env = createEnv();
    env.DB.database.prepare(`INSERT INTO customers (id, nickname, profile_status) VALUES ('A099', '甲', 'complete')`).run();
    env.DB.database.prepare(`INSERT INTO customers (id, nickname, profile_status) VALUES ('A100', '乙', 'complete')`).run();
    const result = await bulkImport(env, [{ code: "101", name: "丙", lineName: "丙" }]);
    assert.equal(result.body.details[0].id, "A101");
});

test("已存在判斷看 `<編號>-` 前綴：再貼一次 005 → 已存在並略過", async () => {
    const env = createEnv();
    seedExistingCustomers(env, SEED_A001_TO_A007);
    const result = await bulkImport(env, itemsFromPaste("005號家玲-小葉娃"));
    assert.deepEqual([result.body.created, result.body.updated, result.body.skipped], [0, 0, 1]);
    assert.equal(result.body.details[0].action, "skipped");
    assert.equal(result.body.details[0].code, "005");
    assert.equal(result.body.details[0].id, "A005", "要回報是哪一位既有客戶");
    assert.match(result.body.details[0].note, /客戶編號已存在/);
    assert.equal(rowsOf(env).length, 7, "不可多出一位重複客戶");
});

test("已存在判斷不受本名／暱稱改動影響（同編號不同名字仍算已存在，並回報差異）", async () => {
    const env = createEnv();
    seedExistingCustomers(env, [["A005", "005", "家玲", "小葉娃"]]);
    const result = await bulkImport(env, [{ code: "005", name: "家玲玲", lineName: "小葉娃娃", mode: "skip" }]);
    assert.equal(result.body.skipped, 1);
    assert.match(result.body.details[0].note, /005-小葉娃娃/);
    assert.match(result.body.details[0].note, /小葉娃娃/);
    const row = rowsOf(env)[0];
    assert.equal(row.custom_display_name, "005-小葉娃", "略過就是不寫入");
    assert.equal(row.nickname, "家玲");
});

test("重複匯入同一份名單：整份預設略過，不會重複配號", async () => {
    const env = createEnv();
    const text = "001號蔡清景 - 蔡清景\n002號鄭雅蘭 - 鄭雅蘭";
    const first = await bulkImport(env, itemsFromPaste(text));
    assert.equal(first.body.created, 2);
    const again = await bulkImport(env, itemsFromPaste(text));
    assert.deepEqual(
        [again.body.created, again.body.updated, again.body.skipped, again.body.failed],
        [0, 0, 2, 0]
    );
    assert.deepEqual(rowsOf(env).map(r => r.id), ["A001", "A002"], "不可產生第二組客戶");
    assert.ok(again.body.details.every(d => d.action === "skipped"));
});

test("同一批資料裡出現重複編號，只處理第一筆（不可配出兩個號）", async () => {
    const env = createEnv();
    const result = await bulkImport(env, [
        { code: "001", name: "蔡清景", lineName: "蔡清景" },
        { code: "001", name: "蔡清景2", lineName: "蔡清景2" }
    ]);
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.created, result.body.skipped], [1, 1]);
    const rows = rowsOf(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "A001");
    assert.equal(rows[0].custom_display_name, "001-蔡清景");
});

test("mode=update：只改既有 A00N 的名稱三欄，line_user_id／pickup_type／address／profile_status 不得被動到", async () => {
    const env = createEnv();
    // 模擬一個已經綁好 LINE、在 LIFF 填過地址的既有客戶
    env.DB.database.prepare(`INSERT INTO customers
        (id, nickname, custom_display_name, line_display_name, line_user_id, pickup_type, address, profile_status, created_at, updated_at)
        VALUES ('A005', '舊名字', '005-舊LINE名', '舊LINE名', 'U-MICHA', '外送', '台北市信義區信義路五段7號', 'complete', '2026-01-01', '2026-01-01')`).run();
    env.DB.database.prepare(`INSERT INTO line_order_inbox
        (message_id, group_id, raw_message, normalized_message, message_time, status)
        VALUES ('MSG-1', 'G1', 'P1 1', 'P1 1', '2026-07-22T10:00:00Z', '已轉正式訂單')`).run();
    env.DB.database.prepare("INSERT INTO orders (id, source_message_id, customer_id, status) VALUES ('ORD-1', 'MSG-1', 'A005', '新訂單')").run();

    const result = await bulkImport(env, [{ code: "005", name: "家玲", lineName: "小葉娃", mode: "update" }]);
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.created, result.body.updated, result.body.skipped], [0, 1, 0]);
    assert.deepEqual(
        [result.body.details[0].code, result.body.details[0].id, result.body.details[0].action],
        ["005", "A005", "updated"]
    );

    const rows = rowsOf(env);
    assert.equal(rows.length, 1, "更新不可新增第二筆");
    const row = rows[0];
    assert.equal(row.id, "A005", "更新的是既有那一列，不是新配號");
    assert.equal(row.custom_display_name, "005-小葉娃");
    assert.equal(row.line_display_name, "小葉娃");
    assert.equal(row.nickname, "家玲");
    assert.equal(row.line_user_id, "U-MICHA", "LINE 綁定不可被動到");
    assert.equal(row.pickup_type, "外送", "取貨方式不可被動到");
    assert.equal(row.address, "台北市信義區信義路五段7號", "LIFF 填的地址不可被清掉");
    assert.equal(row.profile_status, "complete");
    assert.notEqual(row.updated_at, "2026-01-01", "updated_at 要更新");

    // 訂單↔客戶關聯不受影響
    const order = env.DB.database.prepare("SELECT * FROM orders WHERE id = 'ORD-1'").get();
    assert.equal(order.customer_id, "A005");
});

test("001 在顯示名稱前綴裡永遠是字串 \"001\"，不可掉前導零", async () => {
    const env = createEnv();
    await bulkImport(env, itemsFromPaste("1號蔡清景-蔡清景\n012號林小美－林小美"));
    const rows = rowsOf(env);
    assert.equal(rows[0].custom_display_name, "001-蔡清景");
    assert.notEqual(rows[0].custom_display_name, "1-蔡清景");
    assert.equal(rows[1].custom_display_name, "012-林小美");
    // 略過訊息裡也不可退化成 1-
    const again = await bulkImport(env, [{ code: "001", name: "蔡清景", lineName: "蔡清景" }]);
    assert.match(again.body.details[0].note, /A001/);
    assert.equal(again.body.skipped, 1);
});

test("全形破折號／全形空白／全形數字：解析後照樣正確配號與命名", async () => {
    const env = createEnv();
    const text = [
        "　015號　王大明　－　大明　",
        "０１６號陳小華-小華",
        "013號林小美—阿美"
    ].join("\n");
    const result = await bulkImport(env, itemsFromPaste(text));
    assert.deepEqual([result.body.created, result.body.failed], [3, 0]);
    assert.deepEqual(
        rowsOf(env).map(r => [r.id, r.custom_display_name, r.line_display_name, r.nickname]),
        [
            ["A001", "015-大明", "大明", "王大明"],
            ["A002", "016-小華", "小華", "陳小華"],
            ["A003", "013-阿美", "阿美", "林小美"]
        ]
    );
});

test("正確與錯誤混排：好的照樣進、壞的照樣回報，統計數字要對", async () => {
    const env = createEnv();
    seedExistingCustomers(env, [["A001", "001", "蔡清景", "蔡清景"], ["A002", "002", "鄭雅蘭", "鄭雅蘭"]]);
    const result = await bulkImport(env, [
        { code: "001", name: "蔡清景", lineName: "蔡清景", mode: "skip" },
        { code: "002", name: "鄭雅蘭", lineName: "小蘭", mode: "update" },
        { code: "004", name: "陳美娟", lineName: "陳美娟", mode: "skip" },
        { code: "005", name: "", lineName: "小葉娃", mode: "skip" },
        { code: "abc", name: "編號不是數字", lineName: "阿貓", mode: "skip" },
        { code: "006", name: "洪敏玲", lineName: "洪敏玲", mode: "skip" }
    ]);
    assert.deepEqual(
        [result.body.created, result.body.updated, result.body.skipped, result.body.failed],
        [2, 1, 1, 2]
    );
    assert.deepEqual(result.body.details.map(d => d.action), ["skipped", "updated", "created", "failed", "failed", "created"]);
    const rows = rowsOf(env);
    assert.deepEqual(rows.map(r => r.id), ["A001", "A002", "A003", "A004"]);
    assert.equal(rows.find(r => r.id === "A002").custom_display_name, "002-小蘭");
    assert.equal(rows.find(r => r.id === "A002").line_display_name, "小蘭");
    assert.equal(rows.find(r => r.id === "A003").custom_display_name, "004-陳美娟");
    assert.equal(rows.find(r => r.id === "A004").custom_display_name, "006-洪敏玲");
});

test("伺服器端驗證：空編號／非數字編號／空姓名／過長一律不寫入並回報中文原因", async () => {
    const env = createEnv();
    const result = await bulkImport(env, [
        { code: "", name: "沒有編號", lineName: "沒有編號" },
        { code: "003", name: "   ", lineName: "空姓名" },
        { code: "1".repeat(17), name: "編號過長", lineName: "編號過長" },
        { code: "A001", name: "編號不是數字", lineName: "編號不是數字" },
        { code: "004", name: "名".repeat(101), lineName: "名字過長" },
        { code: "005", name: "家玲", lineName: "娃".repeat(101) },
        null,
        { code: "006", name: "洪敏玲", lineName: "洪敏玲" }
    ]);
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.created, result.body.failed], [1, 7]);
    const rows = rowsOf(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "A001");
    assert.equal(rows[0].custom_display_name, "006-洪敏玲");
    // 錯誤訊息一律中文，且不得洩漏 SQL／stack
    for (const detail of result.body.details.filter(d => d.action === "failed")) {
        assert.ok(detail.note && detail.note.length > 0);
        assert.equal(detail.id, "", "失敗的列不可佔用配號");
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
        code: String(index + 1).padStart(3, "0"), name: `客戶${index}`, lineName: `客戶${index}`
    })));
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /一次最多匯入 500 筆/);
    assert.equal(rowsOf(env).length, 0);
});

test("LINE 名稱留空時沿用本名（顯示名稱與 LINE 名稱都用本名）", async () => {
    const env = createEnv();
    await bulkImport(env, [{ code: "007", name: "王小明", lineName: "" }]);
    const row = rowsOf(env)[0];
    assert.equal(row.id, "A001");
    assert.equal(row.custom_display_name, "007-王小明");
    assert.equal(row.line_display_name, "王小明");
    assert.equal(row.nickname, "王小明");
});

test("existingId 只是備援：伺服器仍以 `<編號>-` 前綴為準，前端傳錯不可改到別人", async () => {
    const env = createEnv();
    seedExistingCustomers(env, SEED_A001_TO_A007);
    const result = await bulkImport(env, [{ code: "005", name: "家玲", lineName: "小葉娃", mode: "update", existingId: "A002" }]);
    assert.deepEqual([result.body.created, result.body.updated], [0, 1]);
    assert.equal(result.body.details[0].id, "A005");
    const rows = rowsOf(env);
    assert.equal(rows.find(r => r.id === "A002").custom_display_name, "002-鄭雅蘭", "不可誤改 A002");
    assert.equal(rows.find(r => r.id === "A005").nickname, "家玲");
});

// --- migration-008：備註（本名）要存進 D1 才能跨裝置看到 ---

test("migration-008：匯入新客戶時本名要同時寫進 notes（備註跨裝置保存）", async () => {
    const env = createEnv();
    const result = await bulkImport(env, itemsFromPaste("005號家玲-小葉娃\n006洪敏玲-洪敏玲"));
    assert.deepEqual([result.body.created, result.body.failed], [2, 0]);
    const rows = rowsOf(env);
    assert.deepEqual(
        rows.map(r => [r.id, r.custom_display_name, r.nickname, r.notes]),
        [
            ["A001", "005-小葉娃", "家玲", "家玲"],
            ["A002", "006-洪敏玲", "洪敏玲", "洪敏玲"]
        ],
        "notes 存本名，顯示名稱仍是 <編號>-<LINE暱稱>"
    );
    // GET /api/customers 一定要回傳 notes，否則前端同步下來還是空的（等於沒存）
    const listed = await (await fetchHandler(new Request("https://worker/api/customers", { headers: AUTH }), env, {})).json();
    assert.deepEqual(listed.map(r => r.notes), ["家玲", "洪敏玲"]);
    assert.ok(Object.prototype.hasOwnProperty.call(listed[0], "notes"), "回傳列必須帶 notes 欄位");
});

test("migration-008：mode=update 也要更新 notes，line_user_id／pickup_type／address 仍不得被動到", async () => {
    const env = createEnv();
    env.DB.database.prepare(`INSERT INTO customers
        (id, nickname, custom_display_name, line_display_name, line_user_id, pickup_type, address, notes, profile_status, created_at, updated_at)
        VALUES ('A005', '舊名字', '005-舊LINE名', '舊LINE名', 'U-MICHA', '外送', '台北市信義區信義路五段7號', '舊備註', 'complete', '2026-01-01', '2026-01-01')`).run();

    const result = await bulkImport(env, [{ code: "005", name: "家玲", lineName: "小葉娃", mode: "update" }]);
    assert.deepEqual([result.body.created, result.body.updated, result.body.skipped], [0, 1, 0]);
    const row = rowsOf(env)[0];
    assert.equal(row.notes, "家玲", "備註（本名）要跟著更新");
    assert.equal(row.custom_display_name, "005-小葉娃");
    assert.equal(row.line_display_name, "小葉娃");
    assert.equal(row.nickname, "家玲");
    assert.equal(row.line_user_id, "U-MICHA", "LINE 綁定不可被動到");
    assert.equal(row.pickup_type, "外送", "取貨方式不可被動到");
    assert.equal(row.address, "台北市信義區信義路五段7號", "LIFF 填的地址不可被清掉");
    assert.equal(row.profile_status, "complete");
});

test("migration-008：略過既有客戶時不得偷改 notes", async () => {
    const env = createEnv();
    seedExistingCustomers(env, [["A005", "005", "家玲", "小葉娃"]]);
    env.DB.database.prepare("UPDATE customers SET notes = '團主手寫備註' WHERE id = 'A005'").run();
    const result = await bulkImport(env, [{ code: "005", name: "家玲玲", lineName: "小葉娃", mode: "skip" }]);
    assert.equal(result.body.skipped, 1);
    assert.equal(rowsOf(env)[0].notes, "團主手寫備註");
});

test("migration-008：migration-008 之前建立的客戶（notes 為 NULL）仍可正常讀取與匯入", async () => {
    const env = createEnv();
    // 舊資料：只有 migration-007 為止的欄位，notes 從未被寫過
    env.DB.database.prepare(`INSERT INTO customers
        (id, nickname, custom_display_name, line_display_name, profile_status)
        VALUES ('A001', '蔡清景', '001-蔡清景', '蔡清景', 'complete')`).run();
    assert.equal(rowsOf(env)[0].notes, null);
    const listResponse = await fetchHandler(new Request("https://worker/api/customers", { headers: AUTH }), env, {});
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].notes, null, "舊客戶 notes 是 null，不可爆錯");
    assert.equal(listed[0].customer_display_name, "001-蔡清景");
    // 舊客戶照樣可以被匯入流程略過／更新，不因 notes 為 NULL 而失敗
    const skipResult = await bulkImport(env, [{ code: "001", name: "蔡清景", lineName: "蔡清景", mode: "skip" }]);
    assert.equal(skipResult.body.skipped, 1);
    assert.equal(rowsOf(env)[0].notes, null);
    const updateResult = await bulkImport(env, [{ code: "001", name: "蔡清景", lineName: "蔡清景", mode: "update" }]);
    assert.equal(updateResult.body.updated, 1);
    assert.equal(rowsOf(env)[0].notes, "蔡清景", "更新後才補上備註");
});
