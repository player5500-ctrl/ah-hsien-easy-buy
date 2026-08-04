const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

test("migration 011 保留舊資料、舊商品 product_group_id 為 NULL 並建立必要欄位與索引", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          line_code TEXT UNIQUE,
          price INTEGER NOT NULL DEFAULT 0,
          pickup_price INTEGER,
          delivery_price INTEGER,
          specs TEXT,
          unit TEXT NOT NULL DEFAULT '份',
          description TEXT,
          image_url TEXT,
          updated_at TEXT
        );
        CREATE TABLE orders (id TEXT PRIMARY KEY);
        CREATE TABLE order_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id TEXT NOT NULL,
          product_code TEXT NOT NULL,
          product_id TEXT,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price INTEGER NOT NULL DEFAULT 0,
          amount INTEGER NOT NULL DEFAULT 0,
          item_status TEXT NOT NULL DEFAULT 'active',
          updated_at TEXT
        );
        INSERT INTO products (id, name, line_code, price) VALUES ('P024', '德國Pril洗碗精', 'P024', 199);
        INSERT INTO orders (id) VALUES ('O1');
        INSERT INTO order_items (order_id, product_code, product_id, quantity, unit_price, amount)
          VALUES ('O1', 'P024', 'P024', 2, 199, 398);
    `);

    const migration = fs.readFileSync(
        path.join(__dirname, "..", "migration-011-product-groups.sql"),
        "utf8"
    );
    db.exec(migration);

    // 舊商品保留全部資料，product_group_id 預設 NULL（維持單一商品行為）。
    const product = db.prepare("SELECT * FROM products WHERE id = 'P024'").get();
    assert.equal(product.name, "德國Pril洗碗精");
    assert.equal(product.price, 199);
    assert.equal(product.product_group_id, null);
    assert.equal(product.variant_name, null);
    assert.equal(product.variant_sort, 0);
    assert.equal(product.use_group_image, 0);

    // 舊訂單明細保留，快照欄位預設 NULL（前端沿用即時查詢 fallback）。
    const item = db.prepare("SELECT * FROM order_items WHERE order_id = 'O1'").get();
    assert.equal(item.quantity, 2);
    assert.equal(item.amount, 398);
    assert.equal(item.product_name_snapshot, null);
    assert.equal(item.variant_name_snapshot, null);
    assert.equal(item.specs_snapshot, null);

    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    assert.ok(tables.has("product_groups"));
    assert.ok(tables.has("schema_migrations"));

    const groupIndexes = db.prepare("PRAGMA index_list('product_groups')").all().map(row => row.name);
    assert.ok(groupIndexes.includes("idx_product_groups_enabled"));

    const productIndexes = db.prepare("PRAGMA index_list('products')").all().map(row => row.name);
    assert.ok(productIndexes.includes("idx_products_group"));
    const productIndexColumns = db.prepare("PRAGMA index_info('idx_products_group')").all().map(row => row.name);
    assert.deepEqual(productIndexColumns, ["product_group_id", "variant_sort"]);

    const record = db.prepare("SELECT version, description FROM schema_migrations WHERE version = '011'").get();
    assert.match(record.description, /product_groups/);

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM products").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM order_items").get().count, 1);
});

test("migration 011 可以直接套用在完整 schema.sql 建立的資料庫（模擬既有正式站已跑過所有舊 migration）", () => {
    const db = new DatabaseSync(":memory:");
    // 模擬「已經是 migration-010 完成狀態」的正式站：拿目前 schema.sql，但先去掉本次新增的欄位/表，
    // 確認 migration-011 補回來之後跟 schema.sql 的最終狀態一致。
    const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
    const preMigration011 = schema
        .replace(/-- product_groups[\s\S]*?CREATE INDEX IF NOT EXISTS idx_product_groups_enabled ON product_groups\(enabled\);\n\n/, "")
        .replace(/,\n  product_group_id TEXT REFERENCES product_groups\(id\),\n  variant_name TEXT,\n  variant_sort INTEGER NOT NULL DEFAULT 0,\n  use_group_image INTEGER NOT NULL DEFAULT 0\n\);/, "\n);")
        .replace("CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group_id, variant_sort);\n\n", "")
        .replace(",\n  product_name_snapshot TEXT,\n  variant_name_snapshot TEXT,\n  specs_snapshot TEXT\n);", "\n);");
    assert.ok(!preMigration011.includes("product_groups"), "前置 schema 應該還沒有 product_groups");
    db.exec(preMigration011);
    db.exec("INSERT INTO products (id, name, line_code, price) VALUES ('P001', '既有商品', 'P001', 100);");

    const migration = fs.readFileSync(path.join(__dirname, "..", "migration-011-product-groups.sql"), "utf8");
    db.exec(migration);

    const product = db.prepare("SELECT * FROM products WHERE id = 'P001'").get();
    assert.equal(product.name, "既有商品");
    assert.equal(product.product_group_id, null);

    const columns = db.prepare("PRAGMA table_info('products')").all().map(row => row.name);
    assert.ok(columns.includes("product_group_id"));
    assert.ok(columns.includes("variant_name"));
    assert.ok(columns.includes("variant_sort"));
    assert.ok(columns.includes("use_group_image"));

    const orderItemColumns = db.prepare("PRAGMA table_info('order_items')").all().map(row => row.name);
    assert.ok(orderItemColumns.includes("product_name_snapshot"));
    assert.ok(orderItemColumns.includes("variant_name_snapshot"));
    assert.ok(orderItemColumns.includes("specs_snapshot"));
});
