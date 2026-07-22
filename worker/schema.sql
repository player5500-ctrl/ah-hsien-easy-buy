PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  line_user_id TEXT UNIQUE,
  pickup_type TEXT,
  profile_status TEXT NOT NULL DEFAULT 'complete',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  line_code TEXT UNIQUE,
  price INTEGER NOT NULL DEFAULT 0,
  specs TEXT,
  unit TEXT NOT NULL DEFAULT '份',
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
  group_buy_id TEXT,
  line_group_id TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_code TEXT NOT NULL,
  product_id TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  item_status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_code, order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_customer_group_buy ON orders(customer_id, group_buy_id) WHERE group_buy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_order_product ON order_items(order_id, product_id);

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

CREATE INDEX IF NOT EXISTS idx_webhook_events_status_received ON line_webhook_events(process_status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_changes_order_time ON order_change_logs(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flex_publications_time ON line_flex_publications(created_at DESC);
