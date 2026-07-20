-- Upgrade the original LINE inbox schema while preserving all existing rows.
PRAGMA foreign_keys = OFF;

ALTER TABLE line_order_inbox RENAME TO line_order_inbox_v1;

CREATE TABLE line_order_inbox (
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

INSERT INTO line_order_inbox (
  message_id, group_id, line_user_id, display_name, customer_id, customer_nickname,
  raw_message, normalized_message, parsed_items, action, pickup_type, message_time,
  status, error_reason, processed_at, created_at
)
SELECT
  message_id, group_id, line_user_id, display_name, customer_id, customer_nickname,
  raw_message, normalized_message, parsed_items, 'create', pickup_type, message_time,
  CASE status
    WHEN '已接收' THEN '待處理'
    WHEN '已解析' THEN '可匯入'
    WHEN '待綁定' THEN '待配對客戶'
    WHEN '待確認' THEN '格式不完整'
    WHEN '格式錯誤' THEN '格式不完整'
    WHEN '疑似重複' THEN '疑似重複'
    WHEN '已轉正式訂單' THEN '已轉正式訂單'
    WHEN '已忽略' THEN '已忽略'
    ELSE '待處理'
  END,
  error_reason, processed_at, created_at
FROM line_order_inbox_v1;

DROP TABLE line_order_inbox_v1;

CREATE INDEX idx_line_inbox_status_time ON line_order_inbox(status, message_time DESC);
CREATE INDEX idx_line_inbox_duplicate ON line_order_inbox(group_id, line_user_id, normalized_message, message_time);
CREATE UNIQUE INDEX idx_line_inbox_webhook_event ON line_order_inbox(webhook_event_id) WHERE webhook_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_code, order_id);

PRAGMA foreign_keys = ON;
