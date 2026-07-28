const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

test("migration 009 保留舊資料、舊團購商品預設不限量並建立必要索引與異動表", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE products (id TEXT PRIMARY KEY);
        CREATE TABLE group_buys (id TEXT PRIMARY KEY);
        CREATE TABLE customers (id TEXT PRIMARY KEY);
        CREATE TABLE line_order_inbox (message_id TEXT PRIMARY KEY);
        CREATE TABLE group_buy_products (
            group_buy_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (group_buy_id, product_id)
        );
        CREATE TABLE orders (
            id TEXT PRIMARY KEY,
            source_message_id TEXT NOT NULL,
            customer_id TEXT,
            pickup_type TEXT,
            status TEXT NOT NULL DEFAULT '新訂單',
            group_buy_id TEXT,
            line_group_id TEXT,
            total_amount INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO products (id) VALUES ('P1');
        INSERT INTO group_buys (id) VALUES ('GB1');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES ('GB1', 'P1');
        INSERT INTO orders (id, source_message_id, group_buy_id) VALUES ('O1', 'M1', 'GB1');
    `);

    const migration = fs.readFileSync(
        path.join(__dirname, "..", "migration-009-group-buy-stock.sql"),
        "utf8"
    );
    db.exec(migration);

    const stock = db.prepare("SELECT * FROM group_buy_products WHERE group_buy_id = 'GB1' AND product_id = 'P1'").get();
    assert.equal(stock.enabled, 1);
    assert.equal(stock.stock_enabled, 0);
    assert.equal(stock.incoming_quantity, 0);
    assert.equal(stock.sellable_quantity, 0);
    assert.equal(stock.sold_quantity, 0);
    assert.equal(stock.remaining_quantity, 0);
    assert.equal(stock.low_stock_threshold, 5);

    const order = db.prepare("SELECT * FROM orders WHERE id = 'O1'").get();
    assert.equal(order.payment_status, "未付款");
    assert.equal(order.notes, null);

    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    assert.ok(tables.has("inventory_movements"));
    assert.ok(tables.has("inventory_tx_guards"));
    assert.ok(tables.has("order_mutation_requests"));
    assert.ok(tables.has("schema_migrations"));

    const indexes = db.prepare("PRAGMA index_list('group_buy_products')").all();
    assert.ok(indexes.some(index => index.name === "idx_group_buy_products_pair" && index.unique === 1));
    const indexColumns = db.prepare("PRAGMA index_info('idx_group_buy_products_pair')").all().map(row => row.name);
    assert.deepEqual(indexColumns, ["group_buy_id", "product_id"]);

    const record = db.prepare("SELECT version, description FROM schema_migrations WHERE version = '009'").get();
    assert.match(record.description, /stock limits/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM group_buy_products").get().count, 1);
});
