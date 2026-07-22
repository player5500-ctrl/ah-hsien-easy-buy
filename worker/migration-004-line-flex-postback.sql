-- migration-004: LINE Flex 商品卡、靜默 Postback 與可追蹤訂單更新
-- 僅新增欄位、資料表與索引，不刪除或重建既有資料。
PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN profile_status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE customers ADD COLUMN created_at TEXT;
ALTER TABLE customers ADD COLUMN updated_at TEXT;

ALTER TABLE products ADD COLUMN specs TEXT;
ALTER TABLE products ADD COLUMN unit TEXT;

ALTER TABLE orders ADD COLUMN group_buy_id TEXT;
ALTER TABLE orders ADD COLUMN line_group_id TEXT;
ALTER TABLE orders ADD COLUMN total_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN updated_at TEXT;

ALTER TABLE order_items ADD COLUMN product_id TEXT;
ALTER TABLE order_items ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN item_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE order_items ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS group_buys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','completed')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS group_buy_products (
  group_buy_id TEXT NOT NULL REFERENCES group_buys(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_buy_id, product_id)
);

CREATE TABLE IF NOT EXISTS line_groups (
  group_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  active_group_buy_id TEXT REFERENCES group_buys(id),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS line_webhook_events (
  id TEXT PRIMARY KEY,
  webhook_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  line_user_id TEXT,
  group_id TEXT,
  process_status TEXT NOT NULL CHECK (process_status IN ('processing','processed','failed')),
  error_message TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS order_change_logs (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  customer_id TEXT NOT NULL,
  group_buy_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity_before INTEGER NOT NULL DEFAULT 0,
  quantity_after INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL,
  webhook_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS line_flex_publications (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_buy_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  line_message_id TEXT,
  published_at TEXT,
  published_by TEXT NOT NULL,
  publish_status TEXT NOT NULL CHECK (publish_status IN ('success','failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_group_buy
  ON orders(customer_id, group_buy_id) WHERE group_buy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_order_product
  ON order_items(order_id, product_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status_received
  ON line_webhook_events(process_status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_changes_order_time
  ON order_change_logs(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flex_publications_time
  ON line_flex_publications(created_at DESC);
