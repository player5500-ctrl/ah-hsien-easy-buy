const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { importInboxRecord, processPostback } = require("./index.js");

class D1Statement {
    constructor(database, sql, args = []) {
        this.database = database;
        this.sql = sql;
        this.args = args;
    }

    bind(...args) {
        return new D1Statement(this.database, this.sql, args);
    }

    async run() {
        const result = this.database.prepare(this.sql).run(...this.args);
        return { meta: { changes: Number(result.changes || 0) } };
    }

    async first() {
        return this.database.prepare(this.sql).get(...this.args) || null;
    }

    async all() {
        return { results: this.database.prepare(this.sql).all(...this.args) };
    }
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
        INSERT INTO products (id, name, enabled, line_code, price, specs, unit) VALUES
            ('P1', '手工蛋捲', 1, 'P1', 180, '原味12入', '盒'),
            ('P2', '冰紅茶', 1, 'P2', 60, '1000ml', '瓶'),
            ('STOP', '停售品', 0, 'STOP', 90, '', '份');
        INSERT INTO group_buys (id, name, ends_at, status) VALUES
            ('GB1', '七月團購', '2099-07-31T15:59:59.000Z', 'open'),
            ('OLD', '已截止團購', '2020-01-01T00:00:00.000Z', 'open');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES
            ('GB1', 'P1'), ('GB1', 'P2'), ('GB1', 'STOP'), ('OLD', 'P1');
        INSERT INTO line_groups (group_id, display_name, active_group_buy_id) VALUES ('G1', '測試群組', 'GB1');
    `);
}

function postback(webhookEventId, userId, productId, quantity, groupBuyId = "GB1", action = "set_quantity") {
    const params = new URLSearchParams({ action, groupBuyId, productId });
    if (quantity !== undefined) params.set("quantity", String(quantity));
    return {
        webhookEventId,
        timestamp: Date.parse("2026-07-22T10:00:00Z"),
        groupId: "G1",
        lineUserId: userId,
        displayName: `客戶-${userId}`,
        data: params.toString()
    };
}

test("靜默 Postback：設定數量、防重送、取消、多客戶、多商品與資料庫價格", async () => {
    const db = createD1();
    seed(db);

    const first = await processPostback({ DB: db }, postback("W1", "U1", "P1", 1));
    assert.equal(first.processed, true);
    let item = db.database.prepare("SELECT quantity, unit_price, amount FROM order_items WHERE product_id = 'P1'").get();
    assert.deepEqual({ ...item }, { quantity: 1, unit_price: 180, amount: 180 });

    await processPostback({ DB: db }, postback("W2", "U1", "P1", 1));
    item = db.database.prepare("SELECT quantity FROM order_items WHERE product_id = 'P1'").get();
    assert.equal(item.quantity, 1, "重複按 1份應維持 1，不得累加");

    await processPostback({ DB: db }, postback("W3", "U1", "P1", 3));
    item = db.database.prepare("SELECT quantity, amount FROM order_items WHERE product_id = 'P1'").get();
    assert.deepEqual({ ...item }, { quantity: 3, amount: 540 });

    await processPostback({ DB: db }, postback("W4", "U1", "P2", 2));
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1, "同客戶同團購多商品合併同一訂單");
    assert.equal(db.database.prepare("SELECT total_amount FROM orders").get().total_amount, 660);

    await processPostback({ DB: db }, postback("W5", "U2", "P1", 2));
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 2, "兩位客戶訂單分開");

    const duplicate = await processPostback({ DB: db }, postback("W5", "U2", "P1", 3));
    assert.equal(duplicate.duplicate, true);
    assert.equal(db.database.prepare(`SELECT oi.quantity FROM order_items oi JOIN orders o ON o.id = oi.order_id
        JOIN customers c ON c.id = o.customer_id WHERE c.line_user_id = 'U2' AND oi.product_id = 'P1'`).get().quantity, 2);

    await processPostback({ DB: db }, postback("W6", "U1", "P1", undefined, "GB1", "cancel_item"));
    assert.equal(db.database.prepare(`SELECT COUNT(*) AS count FROM order_items oi JOIN orders o ON o.id = oi.order_id
        JOIN customers c ON c.id = o.customer_id WHERE c.line_user_id = 'U1' AND oi.product_id = 'P1'`).get().count, 0);
    assert.equal(db.database.prepare(`SELECT total_amount FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.line_user_id = 'U1'`).get().total_amount, 120);

    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM line_webhook_events WHERE process_status = 'processed'").get().count, 6);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM order_change_logs").get().count, 6);
    assert.equal(db.database.prepare("SELECT profile_status FROM customers WHERE line_user_id = 'U1'").get().profile_status, "pending");
    db.database.close();
});

test("文字 +1 與 Postback 共用同一訂單，按 3份會覆寫為 3", async () => {
    const db = createD1();
    seed(db);
    db.database.exec(`
        INSERT INTO customers (id, nickname, line_user_id) VALUES ('C1', '文字客戶', 'UTEXT');
        INSERT INTO line_order_inbox
            (message_id, webhook_event_id, group_id, line_user_id, display_name, customer_id, customer_nickname,
             raw_message, normalized_message, parsed_items, action, message_time, status)
        VALUES ('M1', 'WTEXT', 'G1', 'UTEXT', '文字客戶', 'C1', '文字客戶', 'P1+1', 'P1+1',
            '[{"productCode":"P1","quantity":1}]', 'create', '2026-07-22T10:00:00.000Z', '可匯入');
    `);
    const inbox = db.database.prepare("SELECT * FROM line_order_inbox WHERE message_id = 'M1'").get();
    const imported = await importInboxRecord({ DB: db }, inbox);
    assert.equal(imported.groupBuyId, "GB1");
    assert.equal(db.database.prepare("SELECT quantity FROM order_items WHERE product_id = 'P1'").get().quantity, 1);

    await processPostback({ DB: db }, postback("WSET3", "UTEXT", "P1", 3));
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
    assert.equal(db.database.prepare("SELECT quantity FROM order_items WHERE product_id = 'P1'").get().quantity, 3);
    db.database.close();
});

test("LINE 文字收件匣：收到留言不扣庫存，管理者確認轉單後才扣", async () => {
    const db = createD1();
    seed(db);
    db.database.exec(`
        UPDATE group_buy_products SET incoming_quantity = 3, sellable_quantity = 3,
            remaining_quantity = 3, low_stock_threshold = 1, stock_enabled = 1
            WHERE group_buy_id = 'GB1' AND product_id = 'P1';
        INSERT INTO customers (id, nickname, line_user_id) VALUES ('C-LINE', '文字客戶', 'U-LINE');
        INSERT INTO line_order_inbox
            (message_id, webhook_event_id, group_id, line_user_id, display_name, customer_id, customer_nickname,
             raw_message, normalized_message, parsed_items, action, message_time, status)
        VALUES ('M-STOCK', 'W-TEXT-STOCK', 'G1', 'U-LINE', '文字客戶', 'C-LINE', '文字客戶',
            'P1+2', 'P1+2', '[{"productCode":"P1","quantity":2}]', 'create',
            '2026-07-22T10:00:00.000Z', '可匯入');
    `);
    assert.equal(db.database.prepare(`SELECT remaining_quantity FROM group_buy_products
        WHERE group_buy_id = 'GB1' AND product_id = 'P1'`).get().remaining_quantity, 3);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);

    const inbox = db.database.prepare("SELECT * FROM line_order_inbox WHERE message_id = 'M-STOCK'").get();
    await importInboxRecord({ DB: db }, inbox);
    assert.equal(db.database.prepare(`SELECT remaining_quantity FROM group_buy_products
        WHERE group_buy_id = 'GB1' AND product_id = 'P1'`).get().remaining_quantity, 1);
    assert.equal(db.database.prepare("SELECT quantity FROM order_items WHERE product_id = 'P1'").get().quantity, 2);
    assert.equal(db.database.prepare("SELECT movement_type FROM inventory_movements").get().movement_type, "line_order_confirmed");
    db.database.close();
});

test("團購截止或商品停售時不修改訂單，事件留下失敗原因", async () => {
    const db = createD1();
    seed(db);
    const expired = await processPostback({ DB: db }, postback("WOLD", "U1", "P1", 1, "OLD"));
    const stopped = await processPostback({ DB: db }, postback("WSTOP", "U1", "STOP", 1));
    assert.match(expired.error, /截止/);
    assert.match(stopped.error, /停售/);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM line_webhook_events WHERE process_status = 'failed'").get().count, 2);
    db.database.close();
});

test("Postback 庫存控管：事件重送不重扣，售完後新客戶不得超賣", async () => {
    const db = createD1();
    seed(db);
    db.database.exec(`UPDATE group_buy_products SET
        incoming_quantity = 1, sellable_quantity = 1, remaining_quantity = 1,
        low_stock_threshold = 1, stock_enabled = 1
        WHERE group_buy_id = 'GB1' AND product_id = 'P1'`);

    const first = await processPostback({ DB: db }, postback("W-STOCK-1", "U1", "P1", 1));
    assert.equal(first.processed, true);
    assert.deepEqual(
        { ...db.database.prepare(`SELECT sold_quantity, remaining_quantity, stock_status
            FROM group_buy_products WHERE group_buy_id = 'GB1' AND product_id = 'P1'`).get() },
        { sold_quantity: 1, remaining_quantity: 0, stock_status: "sold_out" }
    );

    const redelivery = await processPostback({ DB: db }, postback("W-STOCK-1", "U1", "P1", 1));
    assert.equal(redelivery.duplicate, true);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get().count, 1);

    const soldOut = await processPostback({ DB: db }, postback("W-STOCK-2", "U2", "P1", 1));
    assert.equal(soldOut.error, "本商品已售完");
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
    assert.equal(db.database.prepare(`SELECT remaining_quantity FROM group_buy_products
        WHERE group_buy_id = 'GB1' AND product_id = 'P1'`).get().remaining_quantity, 0);
    db.database.close();
});
