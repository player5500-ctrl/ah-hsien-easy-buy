PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  line_user_id TEXT UNIQUE,
  pickup_type TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  line_code TEXT UNIQUE,
  price INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  image_url TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS line_order_inbox (
  message_id TEXT PRIMARY KEY,
  webhook_event_id TEXT UNIQUE,
  group_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  customer_id TEXT,
  customer_nickname TEXT,
  raw_message TEXT NOT NULL,
  normalized_message TEXT NOT NULL,
  parsed_items TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL DEFAULT 'create' CHECK (action IN ('create', 'replace', 'cancel')),
  target_product_prefix TEXT,
  pickup_type TEXT,
  message_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('待處理','可匯入','待配對客戶','格式不完整','未知商品','疑似重複','已轉正式訂單','已忽略','已取消')),
  error_reason TEXT,
  related_order_id TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_line_inbox_status_time ON line_order_inbox(status, message_time DESC);
CREATE INDEX IF NOT EXISTS idx_line_inbox_duplicate ON line_order_inbox(group_id, line_user_id, normalized_message, message_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_line_inbox_webhook_event ON line_order_inbox(webhook_event_id) WHERE webhook_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_line_user_id ON customers(line_user_id) WHERE line_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_line_code ON products(line_code) WHERE line_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL UNIQUE REFERENCES line_order_inbox(message_id),
  customer_id TEXT NOT NULL,
  pickup_type TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_code TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_code, order_id);
