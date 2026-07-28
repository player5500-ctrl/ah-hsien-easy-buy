-- migration-009: 團購商品簡易庫存控管
-- additive only：既有團購商品全部預設 stock_enabled = 0，舊訂單不會突然被限制。
PRAGMA foreign_keys = ON;

ALTER TABLE group_buy_products ADD COLUMN incoming_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_buy_products ADD COLUMN reserved_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_buy_products ADD COLUMN sellable_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_buy_products ADD COLUMN sold_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_buy_products ADD COLUMN remaining_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_buy_products ADD COLUMN low_stock_threshold INTEGER NOT NULL DEFAULT 5;
ALTER TABLE group_buy_products ADD COLUMN stock_status TEXT NOT NULL DEFAULT 'in_stock';
ALTER TABLE group_buy_products ADD COLUMN stock_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_buy_products ADD COLUMN updated_at TEXT;

-- 後台手動訂單原本只有 localStorage；補上不破壞既有資料的雲端欄位。
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT '未付款';
ALTER TABLE orders ADD COLUMN notes TEXT;
ALTER TABLE orders ADD COLUMN phone_snapshot TEXT;
ALTER TABLE orders ADD COLUMN address_snapshot TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_buy_products_pair
  ON group_buy_products(group_buy_id, product_id);
CREATE INDEX IF NOT EXISTS idx_group_buy_products_stock_alert
  ON group_buy_products(group_buy_id, stock_enabled, stock_status, remaining_quantity);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  group_buy_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  order_id TEXT,
  order_item_id INTEGER,
  movement_type TEXT NOT NULL,
  quantity_change INTEGER NOT NULL,
  quantity_before INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  notes TEXT,
  request_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_group_product_time
  ON inventory_movements(group_buy_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_order
  ON inventory_movements(order_id, created_at DESC);

-- D1 batch 內使用的一次性守門列。valid != 1 會觸發 CHECK，整批交易 rollback。
CREATE TABLE IF NOT EXISTS inventory_tx_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 後台／Excel mutation 的冪等鍵；重送相同 request_id 時不得再次扣庫存。
CREATE TABLE IF NOT EXISTS order_mutation_requests (
  request_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  order_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_migrations (version, description)
VALUES ('009', 'group buy stock limits and sold-out protection');
