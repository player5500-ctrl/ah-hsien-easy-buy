const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

test("migration-004 可由舊 schema 安全升級並保留既有訂單", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE customers (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, line_user_id TEXT UNIQUE, pickup_type TEXT);
        CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, line_code TEXT UNIQUE,
            price INTEGER NOT NULL DEFAULT 0, description TEXT, image_url TEXT, updated_at TEXT);
        CREATE TABLE line_order_inbox (message_id TEXT PRIMARY KEY, webhook_event_id TEXT UNIQUE, group_id TEXT NOT NULL,
            line_user_id TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT '', customer_id TEXT, customer_nickname TEXT,
            raw_message TEXT NOT NULL, normalized_message TEXT NOT NULL, parsed_items TEXT NOT NULL DEFAULT '[]',
            action TEXT NOT NULL DEFAULT 'create', target_product_prefix TEXT, pickup_type TEXT, message_time TEXT NOT NULL,
            status TEXT NOT NULL, error_reason TEXT, related_order_id TEXT, processed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE orders (id TEXT PRIMARY KEY, source_message_id TEXT NOT NULL UNIQUE REFERENCES line_order_inbox(message_id),
            customer_id TEXT NOT NULL, pickup_type TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
            product_code TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0));
        INSERT INTO customers (id, nickname) VALUES ('C1', '舊客戶');
        INSERT INTO products (id, name, line_code, price) VALUES ('P1', '舊商品', 'P1', 100);
        INSERT INTO line_order_inbox (message_id, group_id, raw_message, normalized_message, message_time, status)
            VALUES ('M1', 'G1', 'P1+1', 'P1+1', '2026-07-01T00:00:00Z', '已轉正式訂單');
        INSERT INTO orders (id, source_message_id, customer_id, status) VALUES ('O1', 'M1', 'C1', '新訂單');
        INSERT INTO order_items (order_id, product_code, quantity) VALUES ('O1', 'P1', 1);
    `);
    db.exec(fs.readFileSync(path.join(__dirname, "..", "migration-004-line-flex-postback.sql"), "utf8"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'O1'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = 'O1'").get().count, 1);
    for (const table of ["group_buys", "group_buy_products", "line_groups", "line_webhook_events", "order_change_logs", "line_flex_publications"]) {
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_customer_group_buy'").get().count, 1);
    db.close();
});
