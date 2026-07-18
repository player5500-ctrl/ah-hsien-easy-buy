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
  line_code TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS line_order_inbox (
  message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  customer_id TEXT,
  customer_nickname TEXT,
  raw_message TEXT NOT NULL,
  normalized_message TEXT NOT NULL,
  parsed_items TEXT NOT NULL DEFAULT '[]',
  pickup_type TEXT,
  message_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('已接收','已解析','待綁定','待確認','格式錯誤','疑似重複','已轉正式訂單','已忽略')),
  error_reason TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_line_inbox_status_time ON line_order_inbox(status, message_time DESC);
CREATE INDEX IF NOT EXISTS idx_line_inbox_duplicate ON line_order_inbox(group_id, line_user_id, normalized_message, message_time);
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
