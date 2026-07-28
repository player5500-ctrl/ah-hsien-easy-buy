const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
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

function seed(db) {
    db.database.exec(`
        INSERT INTO products (id, name, enabled, line_code, price, unit) VALUES
          ('P1', 'Pril檸檬', 1, 'P024-A', 180, '組'),
          ('P2', 'Pril蘆薈', 1, 'P024-B', 200, '組');
        INSERT INTO group_buys (id, name, ends_at, status) VALUES
          ('GB1', '[TEST] 庫存控管驗收團', '2099-12-31T15:59:59.000Z', 'open');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES
          ('GB1', 'P1'), ('GB1', 'P2');
        INSERT INTO customers (id, nickname) VALUES ('C1', '甲'), ('C2', '乙');
    `);
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
    return worker.fetch(request(method, pathname, body), { DB: db, ADMIN_API_KEY: "test-admin" }, {});
}

async function configure(db, productId, incoming, reserved = 0, threshold = 3) {
    const response = await call(db, "PUT", `/api/group-buys/GB1/stock/${productId}`, {
        stockEnabled: true,
        incomingQuantity: incoming,
        reservedQuantity: reserved,
        lowStockThreshold: threshold
    });
    assert.equal(response.status, 200);
    return response.json();
}

function adminOrder(requestId, quantity, status = "新訂單") {
    return {
        requestId,
        groupBuyId: "GB1",
        customerId: "C1",
        pickupType: "自取",
        paymentStatus: "未付款",
        orderStatus: status,
        phone: "0912",
        address: "",
        notes: "後台測試",
        items: status === "已取消" ? [] : [{ productId: "P1", quantity, unitPrice: 180 }]
    };
}

test("庫存管理 API：設定、查詢、人工調整及 movement", async () => {
    const db = createD1();
    seed(db);
    const configured = await configure(db, "P1", 30, 2, 5);
    assert.equal(configured.stock.sellableQuantity, 28);

    const list = await (await call(db, "GET", "/api/group-buys/GB1/stock")).json();
    assert.equal(list.stocks.find(stock => stock.productId === "P1").remainingQuantity, 28);

    const adjusted = await call(db, "POST", "/api/group-buys/GB1/stock/P1/adjust", {
        quantityChange: 2,
        reason: "追加到貨"
    });
    assert.equal(adjusted.status, 200);
    assert.equal((await adjusted.json()).stock.remainingQuantity, 30);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE movement_type='admin_adjustment'").get().c, 1);
    db.database.close();
});

test("後台手動新增扣庫存、減量回補、取消回補、恢復再檢查", async () => {
    const db = createD1();
    seed(db);
    await configure(db, "P1", 10, 1, 3);

    let response = await call(db, "PUT", "/api/admin/orders/ADM-1", adminOrder("REQ-1", 2));
    assert.equal(response.status, 200);
    assert.equal(db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id='P1'").get().remaining_quantity, 7);

    response = await call(db, "PUT", "/api/admin/orders/ADM-1", adminOrder("REQ-2", 1));
    assert.equal(response.status, 200);
    assert.equal(db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id='P1'").get().remaining_quantity, 8);

    response = await call(db, "PUT", "/api/admin/orders/ADM-1", adminOrder("REQ-3", 0, "已取消"));
    assert.equal(response.status, 200);
    assert.equal(db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id='P1'").get().remaining_quantity, 9);
    assert.equal(db.database.prepare("SELECT status FROM orders WHERE id='ADM-1'").get().status, "已取消");

    response = await call(db, "PUT", "/api/admin/orders/ADM-1", adminOrder("REQ-4", 2));
    assert.equal(response.status, 200);
    assert.equal(db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id='P1'").get().remaining_quantity, 7);
    assert.equal(db.database.prepare("SELECT movement_type FROM inventory_movements ORDER BY rowid DESC LIMIT 1").get().movement_type, "order_restored");
    db.database.close();
});

test("後台超賣回409，訂單與庫存皆不變；相同 requestId 不重扣", async () => {
    const db = createD1();
    seed(db);
    await configure(db, "P1", 2);

    let response = await call(db, "PUT", "/api/admin/orders/ADM-1", adminOrder("REQ-1", 3));
    assert.equal(response.status, 409);
    const error = await response.json();
    assert.equal(error.error, "INSUFFICIENT_STOCK");
    assert.equal(error.remainingQuantity, 2);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 0);

    response = await call(db, "PUT", "/api/admin/orders/ADM-1", adminOrder("REQ-2", 1));
    assert.equal(response.status, 200);
    response = await call(db, "PUT", "/api/admin/orders/ADM-1", adminOrder("REQ-2", 1));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate, true);
    assert.equal(db.database.prepare("SELECT sold_quantity FROM group_buy_products WHERE product_id='P1'").get().sold_quantity, 1);
    db.database.close();
});

test("Excel 預覽不扣庫存；正式確認後才扣，重送不重扣", async () => {
    const db = createD1();
    seed(db);
    await configure(db, "P1", 10);
    const rows = [
        { customerId: "C1", pickupType: "自取", productId: "P1", quantity: 2, unitPrice: 180 },
        { customerId: "C1", pickupType: "自取", productId: "P1", quantity: 1, unitPrice: 180 }
    ];
    let response = await call(db, "POST", "/api/orders/import/preview", { groupBuyId: "GB1", rows });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.valid, true);
    assert.equal(preview.stockChecks[0].requestedIncrease, 3);
    assert.equal(db.database.prepare("SELECT sold_quantity FROM group_buy_products WHERE product_id='P1'").get().sold_quantity, 0);

    response = await call(db, "POST", "/api/orders/import/confirm", {
        requestId: "XLS-REQ-1", groupBuyId: "GB1", rows
    });
    assert.equal(response.status, 200);
    assert.equal(db.database.prepare("SELECT sold_quantity FROM group_buy_products WHERE product_id='P1'").get().sold_quantity, 3);

    response = await call(db, "POST", "/api/orders/import/confirm", {
        requestId: "XLS-REQ-1", groupBuyId: "GB1", rows
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate, true);
    assert.equal(db.database.prepare("SELECT sold_quantity FROM group_buy_products WHERE product_id='P1'").get().sold_quantity, 3);
    db.database.close();
});

test("Excel 任一商品庫存不足時整批 rollback，不產生半套訂單", async () => {
    const db = createD1();
    seed(db);
    await configure(db, "P1", 10);
    await configure(db, "P2", 1);
    const rows = [
        { customerId: "C1", pickupType: "自取", productId: "P1", quantity: 2 },
        { customerId: "C2", pickupType: "自取", productId: "P2", quantity: 2 }
    ];
    const previewResponse = await call(db, "POST", "/api/orders/import/preview", { groupBuyId: "GB1", rows });
    const preview = await previewResponse.json();
    assert.equal(preview.valid, false);
    assert.equal(preview.stockChecks.find(row => row.productId === "P2").status, "insufficient_stock");
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 0);

    const response = await call(db, "POST", "/api/orders/import/confirm", {
        requestId: "XLS-FAIL", groupBuyId: "GB1", rows
    });
    assert.equal(response.status, 409);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 0);
    assert.equal(db.database.prepare("SELECT sold_quantity FROM group_buy_products WHERE product_id='P1'").get().sold_quantity, 0);
    assert.equal(db.database.prepare("SELECT sold_quantity FROM group_buy_products WHERE product_id='P2'").get().sold_quantity, 0);
    db.database.close();
});
