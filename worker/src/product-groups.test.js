const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const worker = require("./index.js");

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

function createD1() {
    const database = new DatabaseSync(":memory:");
    database.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    return {
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
}

function request(method, pathname, body) {
    return new Request(`https://worker.test${pathname}`, {
        method,
        headers: {
            authorization: "Bearer test-admin",
            ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

async function call(db, method, pathname, body) {
    const response = await worker.fetch(request(method, pathname, body), { DB: db, ADMIN_API_KEY: "test-admin", LIFF_ID: "test-liff-id" }, {});
    let json = null;
    try { json = await response.json(); } catch (_error) { json = null; }
    return { status: response.status, json };
}

function prilPayload(requestId) {
    return {
        requestId,
        name: "德國 Pril 洗碗精",
        description: "德國進口洗碗精",
        enabled: true,
        variants: [
            { variant_name: "檨檬", specs: "653ml x 3瓶", price: 210, pickup_price: 210, delivery_price: 225 },
            { variant_name: "蘆薈", specs: "750ml x 3瓶", price: 210, pickup_price: 210, delivery_price: 225 }
        ]
    };
}

test("建立主商品＋多個口味：各口味擁有獨立商品編號與名稱", async () => {
    const db = createD1();
    const result = await call(db, "POST", "/api/product-groups", prilPayload("req-create-1"));
    assert.equal(result.status, 201);
    assert.equal(result.json.created, true);
    assert.equal(result.json.variantIds.length, 2);
    const [variantA, variantB] = result.json.variantIds;
    assert.match(variantA, /^P\d{3}-A$/);
    assert.match(variantB, /^P\d{3}-B$/);

    const list = await call(db, "GET", "/api/product-groups");
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].name, "德國 Pril 洗碗精");
    assert.equal(list.json[0].variants.length, 2);
    assert.equal(list.json[0].variants[0].variant_name, "檨檬");
    assert.equal(list.json[0].variants[0].name, "德國 Pril 洗碗精 檨檬");
    assert.equal(list.json[0].variants[0].price, 210);
    assert.equal(list.json[0].variants[1].variant_name, "蘆薈");

    // 兩個口味的 id 不同、各自獨立
    assert.notEqual(list.json[0].variants[0].id, list.json[0].variants[1].id);
});

test("重複送出同一個 requestId 不會建立第二組（防止重複點擊）", async () => {
    const db = createD1();
    const first = await call(db, "POST", "/api/product-groups", prilPayload("req-dup-1"));
    assert.equal(first.status, 201);
    const second = await call(db, "POST", "/api/product-groups", prilPayload("req-dup-1"));
    assert.equal(second.json.duplicate, true);

    const groups = db.database.prepare("SELECT COUNT(*) AS count FROM product_groups").get();
    assert.equal(groups.count, 1);
    const products = db.database.prepare("SELECT COUNT(*) AS count FROM products").get();
    assert.equal(products.count, 2);
});

test("任一口味驗證失敗時，不建立任何主商品或口味資料（不留下半組資料）", async () => {
    const db = createD1();
    const payload = prilPayload("req-fail-1");
    payload.variants[1].variant_name = ""; // 第二個口味缺口味名稱
    const result = await call(db, "POST", "/api/product-groups", payload);
    assert.equal(result.status, 400);
    assert.match(result.json.error, /口味.*名稱必填/);

    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM product_groups").get().count, 0);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM products").get().count, 0);
});

test("同一主商品內口味名稱不可重複", async () => {
    const db = createD1();
    const payload = prilPayload("req-samename-1");
    payload.variants[1].variant_name = "檨檬";
    const result = await call(db, "POST", "/api/product-groups", payload);
    assert.equal(result.status, 400);
    assert.match(result.json.error, /不可重複/);
});

test("新增口味到既有主商品：自動取得下一個口味代號，重複名稱會被拒絕", async () => {
    const db = createD1();
    const created = await call(db, "POST", "/api/product-groups", prilPayload("req-addvariant-1"));
    const groupId = created.json.id;

    const third = await call(db, "POST", `/api/product-groups/${groupId}/variants`, {
        requestId: "req-addvariant-2",
        variant_name: "無香精",
        specs: "650ml x 3瓶",
        price: 220
    });
    assert.equal(third.status, 201);
    assert.match(third.json.id, /^P\d{3}-C$/);

    const dupName = await call(db, "POST", `/api/product-groups/${groupId}/variants`, {
        requestId: "req-addvariant-3",
        variant_name: "無香精",
        price: 220
    });
    assert.equal(dupName.status, 409);

    const group = await call(db, "GET", `/api/product-groups/${groupId}`);
    assert.equal(group.json.variants.length, 3);
});

test("口味代號超過 26 個時使用 AA/AB", async () => {
    const db = createD1();
    const variants = Array.from({ length: 27 }, (_unused, index) => ({
        variant_name: `款式${index + 1}`,
        price: 100
    }));
    const result = await call(db, "POST", "/api/product-groups", { requestId: "req-27", name: "多款商品", variants });
    assert.equal(result.status, 201);
    assert.equal(result.json.variantIds.length, 27);
    assert.match(result.json.variantIds[25], /^P\d{3}-Z$/);
    assert.match(result.json.variantIds[26], /^P\d{3}-AA$/);
});

test("更新單一口味：內容可改、口味代號不可變更；找錯主商品回 404", async () => {
    const db = createD1();
    const created = await call(db, "POST", "/api/product-groups", prilPayload("req-update-1"));
    const groupId = created.json.id;
    const variantId = created.json.variantIds[0];

    const updated = await call(db, "PUT", `/api/product-groups/${groupId}/variants/${variantId}`, {
        variant_name: "檨檬(加大)",
        specs: "800ml x 3瓶",
        price: 230,
        pickup_price: 230,
        delivery_price: 245
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.id, variantId);

    const group = await call(db, "GET", `/api/product-groups/${groupId}`);
    const variant = group.json.variants.find(v => v.id === variantId);
    assert.equal(variant.variant_name, "檨檬(加大)");
    assert.equal(variant.price, 230);
    assert.equal(variant.name, "德國 Pril 洗碗精 檨檬(加大)");

    const wrongGroup = await call(db, "PUT", `/api/product-groups/PG999/variants/${variantId}`, {
        variant_name: "測試", price: 1
    });
    assert.equal(wrongGroup.status, 404);
});

test("停用整組：所有口味的 enabled 一併變成 0；停用不影響庫存或訂單資料", async () => {
    const db = createD1();
    const created = await call(db, "POST", "/api/product-groups", prilPayload("req-disable-1"));
    const groupId = created.json.id;

    const disabled = await call(db, "PUT", `/api/product-groups/${groupId}`, {
        name: "德國 Pril 洗碗精", enabled: false
    });
    assert.equal(disabled.status, 200);

    const group = await call(db, "GET", `/api/product-groups/${groupId}`);
    assert.equal(group.json.enabled, 0);
    assert.ok(group.json.variants.every(v => v.enabled === 0));
});

test("刪除主商品群組：有訂單紀錄的口味擋下整組刪除；乾淨的群組可以刪除", async () => {
    const db = createD1();
    const created = await call(db, "POST", "/api/product-groups", prilPayload("req-delete-1"));
    const groupId = created.json.id;
    const [variantA] = created.json.variantIds;

    db.database.exec(`
        INSERT INTO customers (id, nickname) VALUES ('C1', '甲');
        INSERT INTO group_buys (id, name, ends_at, status) VALUES ('GB1', '測試團', '2099-12-31T00:00:00.000Z', 'open');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES ('GB1', '${variantA}');
        INSERT INTO line_order_inbox (message_id, group_id, line_user_id, display_name, raw_message, normalized_message, message_time, status)
          VALUES ('M1', 'G1', 'U1', '甲', 'raw', 'raw', '2026-01-01T00:00:00.000Z', '已轉正式訂單');
        INSERT INTO orders (id, source_message_id, customer_id, status, group_buy_id) VALUES ('O1', 'M1', 'C1', '新訂單', 'GB1');
        INSERT INTO order_items (order_id, product_code, product_id, quantity, unit_price, amount)
          VALUES ('O1', '${variantA}', '${variantA}', 1, 210, 210);
    `);

    const blocked = await call(db, "DELETE", `/api/product-groups/${groupId}`);
    assert.equal(blocked.status, 409);

    // 拿掉訂單參照後，另一個乾淨的群組應該可以整組刪除
    const clean = await call(db, "POST", "/api/product-groups", prilPayload("req-delete-2"));
    const cleanGroupId = clean.json.id;
    const removed = await call(db, "DELETE", `/api/product-groups/${cleanGroupId}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.deleted, true);
    assert.equal(removed.json.removedVariantIds.length, 2);

    const stillThere = await call(db, "GET", `/api/product-groups/${cleanGroupId}`);
    assert.equal(stillThere.status, 404);
});

test("合併既有商品：只寫入分組欄位，不改變 id、價格、既有訂單參照；已分組商品不可再合併", async () => {
    const db = createD1();
    db.database.exec(`
        INSERT INTO products (id, name, enabled, line_code, price, specs) VALUES
          ('P010', 'old洗衣精原味', 1, 'P010', 150, '1000ml'),
          ('P011', 'old洗衣精薰衣草', 1, 'P011', 160, '1000ml');
    `);

    const preview = await call(db, "POST", "/api/product-groups/merge-existing/preview", {
        name: "old洗衣精",
        product_ids: ["P010", "P011"],
        variant_names: { P010: "原味", P011: "薰衣草" }
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.preview, true);
    assert.equal(preview.json.variants.length, 2);

    const applied = await call(db, "POST", "/api/product-groups/merge-existing", {
        requestId: "req-merge-1",
        name: "old洗衣精",
        product_ids: ["P010", "P011"],
        variant_names: { P010: "原味", P011: "薰衣草" }
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.json.merged, true);
    const groupId = applied.json.id;

    // id、名稱、價格完全不變，只多了分組欄位
    const p010 = db.database.prepare("SELECT * FROM products WHERE id = 'P010'").get();
    assert.equal(p010.name, "old洗衣精原味");
    assert.equal(p010.price, 150);
    assert.equal(p010.product_group_id, groupId);
    assert.equal(p010.variant_name, "原味");

    const p011 = db.database.prepare("SELECT * FROM products WHERE id = 'P011'").get();
    assert.equal(p011.variant_name, "薰衣草");
    assert.equal(p011.price, 160);

    // 已經分組的商品不能再被合併
    db.database.exec("INSERT INTO products (id, name, enabled, line_code, price) VALUES ('P012', 'other', 1, 'P012', 100);");
    const conflict = await call(db, "POST", "/api/product-groups/merge-existing/preview", {
        name: "再合併一次", product_ids: ["P010", "P012"]
    });
    assert.equal(conflict.status, 409);
});

test("LINE 商品卡預覽／發布：帶 product_group_id 時合併成一張主商品卡（預設行為）", async () => {
    const db = createD1();
    const created = await call(db, "POST", "/api/product-groups", prilPayload("req-flex-1"));
    const groupId = created.json.id;
    const [lemon, aloe] = created.json.variantIds;
    db.database.exec(`
        INSERT INTO group_buys (id, name, ends_at, status) VALUES ('GB1', '[TEST] Pril 團', '2099-12-31T15:59:59.000Z', 'open');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES ('GB1', '${lemon}'), ('GB1', '${aloe}');
    `);

    const preview = await call(db, "POST", "/api/line/flex-preview", {
        group_id: "G1", group_buy_id: "GB1", product_group_id: groupId
    });
    assert.equal(preview.status, 200);
    const serialized = JSON.stringify(preview.json.flex_message);
    assert.match(serialized, /共有 2 種口味：檨檬／蘆薈/);
    assert.doesNotMatch(serialized, /displayText/i);

    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ sentMessages: [{ id: "LINE-MSG-1" }] }), {
        status: 200, headers: { "content-type": "application/json" }
    });
    try {
        const response = await worker.fetch(
            new Request("https://worker.test/api/line/publish", {
                method: "POST",
                headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
                body: JSON.stringify({ group_id: "G1", group_buy_id: "GB1", product_group_id: groupId, published_by: "測試" })
            }),
            { DB: db, ADMIN_API_KEY: "test-admin", LINE_CHANNEL_ACCESS_TOKEN: "token", LIFF_ID: "test-liff-id" },
            {}
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.line_message_id, "LINE-MSG-1");
    } finally {
        global.fetch = originalFetch;
    }

    // 記錄了一次發布，且沿用既有 line_flex_publications 表（product_id 欄位存主商品群組 id，PG 開頭好辨識）。
    const publication = db.database.prepare("SELECT * FROM line_flex_publications ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(publication.product_id, groupId);
    assert.equal(publication.publish_status, "success");
});

test("沒有帳號金鑰時 /api/product-groups 回 401", async () => {
    const db = createD1();
    const response = await worker.fetch(
        new Request("https://worker.test/api/product-groups", { method: "GET" }),
        { DB: db, ADMIN_API_KEY: "test-admin" },
        {}
    );
    assert.equal(response.status, 401);
});
