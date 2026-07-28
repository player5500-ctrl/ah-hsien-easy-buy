const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const Inventory = require("./inventory.js");

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
          ('P2', 'Pril蘆薈', 1, 'P024-B', 180, '組');
        INSERT INTO group_buys (id, name, ends_at, status) VALUES
          ('GB1', '[TEST] 庫存控管驗收團', '2099-12-31T15:59:59.000Z', 'open');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES
          ('GB1', 'P1'), ('GB1', 'P2');
        INSERT INTO customers (id, nickname) VALUES ('C1', '甲'), ('C2', '乙');
    `);
}

function preStatements(db, orderId, customerId) {
    return [
        db.prepare(`INSERT OR IGNORE INTO line_order_inbox
            (message_id, group_id, line_user_id, display_name, customer_id, raw_message,
             normalized_message, parsed_items, action, message_time, status)
            VALUES (?, '', '', '', ?, '測試正式訂單', '測試正式訂單', '[]', 'replace',
                CURRENT_TIMESTAMP, '已轉正式訂單')`).bind(`test:${orderId}`, customerId),
        db.prepare(`INSERT OR IGNORE INTO orders
            (id, source_message_id, customer_id, pickup_type, status, group_buy_id, total_amount)
            VALUES (?, ?, ?, '自取', '新訂單', 'GB1', 0)`)
            .bind(orderId, `test:${orderId}`, customerId)
    ];
}

async function setQty(db, {
    orderId = "O1", customerId = "C1", productId = "P1", quantity,
    sourceType = "admin", requestId
}) {
    return Inventory.executeOrderMutation({ DB: db }, {
        orderId,
        groupBuyId: "GB1",
        customerId,
        changes: [{ productId, productCode: productId, quantity, unitPrice: 180 }],
        sourceType,
        requestId,
        preStatements: preStatements(db, orderId, customerId),
        activeStatus: "新訂單",
        pickupType: "自取"
    });
}

test("進貨30、保留2，可賣28；低庫存與售完狀態由後端計算", async () => {
    const db = createD1();
    seed(db);
    const stock = await Inventory.configureStock({ DB: db }, "GB1", "P1", {
        incomingQuantity: 30,
        reservedQuantity: 2,
        lowStockThreshold: 5,
        stockEnabled: true
    });
    assert.equal(stock.sellableQuantity, 28);
    assert.equal(stock.soldQuantity, 0);
    assert.equal(stock.remainingQuantity, 28);
    assert.equal(stock.stockStatus, "in_stock");
    db.database.close();
});

test("建立2組訂單扣2；1改3只再扣2；5改2回補3", async () => {
    const db = createD1();
    seed(db);
    await Inventory.configureStock({ DB: db }, "GB1", "P1", {
        incomingQuantity: 30, reservedQuantity: 2, lowStockThreshold: 5, stockEnabled: true
    });
    await setQty(db, { quantity: 2 });
    assert.equal((await Inventory.getStock({ DB: db }, "GB1", "P1")).remaining_quantity, 26);

    await setQty(db, { quantity: 1 });
    await setQty(db, { quantity: 3 });
    let stock = await Inventory.getStock({ DB: db }, "GB1", "P1");
    assert.equal(stock.sold_quantity, 3);
    assert.equal(stock.remaining_quantity, 25);

    await setQty(db, { quantity: 5 });
    await setQty(db, { quantity: 2 });
    stock = await Inventory.getStock({ DB: db }, "GB1", "P1");
    assert.equal(stock.sold_quantity, 2);
    assert.equal(stock.remaining_quantity, 26);
    db.database.close();
});

test("取消3組回補3；取消後恢復2組會重新扣庫存", async () => {
    const db = createD1();
    seed(db);
    await Inventory.configureStock({ DB: db }, "GB1", "P1", {
        incomingQuantity: 10, reservedQuantity: 1, lowStockThreshold: 3, stockEnabled: true
    });
    await setQty(db, { quantity: 3 });
    await setQty(db, { quantity: 0 });
    let stock = await Inventory.getStock({ DB: db }, "GB1", "P1");
    assert.equal(stock.remaining_quantity, 9);
    assert.equal(db.database.prepare("SELECT status FROM orders WHERE id='O1'").get().status, "已取消");

    await setQty(db, { quantity: 2 });
    stock = await Inventory.getStock({ DB: db }, "GB1", "P1");
    assert.equal(stock.remaining_quantity, 7);
    assert.equal(db.database.prepare("SELECT movement_type FROM inventory_movements ORDER BY created_at DESC, rowid DESC LIMIT 1").get().movement_type, "order_restored");
    db.database.close();
});

test("剩餘2要求3回409，訂單與庫存完整 rollback", async () => {
    const db = createD1();
    seed(db);
    await Inventory.configureStock({ DB: db }, "GB1", "P1", {
        incomingQuantity: 2, reservedQuantity: 0, lowStockThreshold: 1, stockEnabled: true
    });
    await assert.rejects(
        () => setQty(db, { quantity: 3 }),
        error => error instanceof Inventory.InventoryHttpError
            && error.status === 409
            && error.code === "INSUFFICIENT_STOCK"
            && error.remainingQuantity === 2
    );
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 0);
    assert.equal(db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id='P1'").get().remaining_quantity, 2);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE order_id='O1'").get().c, 0);
    db.database.close();
});

test("競爭條件：只剩1組時兩位同時訂1組，只能一位成功且不得超賣", async () => {
    const db = createD1();
    seed(db);
    await Inventory.configureStock({ DB: db }, "GB1", "P1", {
        incomingQuantity: 1, reservedQuantity: 0, lowStockThreshold: 1, stockEnabled: true
    });
    const results = await Promise.allSettled([
        setQty(db, { orderId: "O1", customerId: "C1", quantity: 1 }),
        setQty(db, { orderId: "O2", customerId: "C2", quantity: 1 })
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const stock = await Inventory.getStock({ DB: db }, "GB1", "P1");
    assert.equal(stock.sold_quantity, 1);
    assert.equal(stock.remaining_quantity, 0);
    assert.equal(stock.stock_status, "sold_out");
    assert.equal(db.database.prepare("SELECT COALESCE(SUM(quantity),0) AS q FROM order_items").get().q, 1);
    db.database.close();
});

test("重複 request_id 不重複扣庫存", async () => {
    const db = createD1();
    seed(db);
    await Inventory.configureStock({ DB: db }, "GB1", "P1", {
        incomingQuantity: 10, reservedQuantity: 0, lowStockThreshold: 2, stockEnabled: true
    });
    const first = await setQty(db, { quantity: 2, requestId: "REQ-1" });
    const duplicate = await setQty(db, { quantity: 2, requestId: "REQ-1" });
    assert.equal(first.applied, true);
    assert.equal(duplicate.duplicate, true);
    const stock = await Inventory.getStock({ DB: db }, "GB1", "P1");
    assert.equal(stock.sold_quantity, 2);
    assert.equal(stock.remaining_quantity, 8);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE order_id='O1'").get().c, 1);
    db.database.close();
});

test("stock_enabled=0 沿用不限量舊行為", async () => {
    const db = createD1();
    seed(db);
    await setQty(db, { quantity: 99 });
    const stock = await Inventory.getStock({ DB: db }, "GB1", "P1");
    assert.equal(stock.stock_enabled, 0);
    assert.equal(stock.sold_quantity, 0);
    assert.equal(db.database.prepare("SELECT quantity FROM order_items WHERE order_id='O1'").get().quantity, 99);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM inventory_movements").get().c, 0);
    db.database.close();
});

test("人工調整寫入 movement，重新核對不會靜默覆蓋", async () => {
    const db = createD1();
    seed(db);
    await Inventory.configureStock({ DB: db }, "GB1", "P1", {
        incomingQuantity: 10, reservedQuantity: 1, lowStockThreshold: 3, stockEnabled: true
    });
    const adjusted = await Inventory.adjustStock({ DB: db }, "GB1", "P1", {
        quantityChange: 2,
        reason: "追加到貨"
    });
    assert.equal(adjusted.incomingQuantity, 12);
    assert.equal(adjusted.remainingQuantity, 11);
    assert.equal(db.database.prepare("SELECT movement_type, notes FROM inventory_movements ORDER BY rowid DESC LIMIT 1").get().movement_type, "admin_adjustment");

    db.database.prepare("UPDATE group_buy_products SET sold_quantity=5, remaining_quantity=6 WHERE group_buy_id='GB1' AND product_id='P1'").run();
    const preview = await Inventory.reconciliationPreview({ DB: db }, "GB1");
    assert.equal(preview.find(row => row.productId === "P1").difference, -5);
    assert.equal(db.database.prepare("SELECT sold_quantity FROM group_buy_products WHERE product_id='P1'").get().sold_quantity, 5, "預覽不可修改");
    const fixed = await Inventory.applyReconciliation({ DB: db }, "GB1", { confirmed: true, reason: "驗收核對" });
    assert.equal(fixed.corrected, 1);
    assert.equal(db.database.prepare("SELECT sold_quantity FROM group_buy_products WHERE product_id='P1'").get().sold_quantity, 0);
    db.database.close();
});
