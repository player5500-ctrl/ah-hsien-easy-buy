-- Apply once to a database created with the original schema.
-- Existing mojibake status values should be reviewed before rebuilding the CHECK constraint.
ALTER TABLE line_order_inbox ADD COLUMN webhook_event_id TEXT;
ALTER TABLE line_order_inbox ADD COLUMN action TEXT NOT NULL DEFAULT 'create';
ALTER TABLE line_order_inbox ADD COLUMN target_product_prefix TEXT;
ALTER TABLE line_order_inbox ADD COLUMN related_order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_line_inbox_webhook_event ON line_order_inbox(webhook_event_id) WHERE webhook_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_code, order_id);
