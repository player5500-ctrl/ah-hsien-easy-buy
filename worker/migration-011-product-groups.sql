-- migration-011: 一個商品、多個口味／款式（product_groups）
--
-- 需求：客戶只看到一個主商品（例：德國 Pril 洗碗精），選擇口味後才決定實際下單的商品；
--       系統內部每個口味仍是 products 的獨立商品，各自獨立價格、庫存、訂單與統計。
--
-- 作法（additive only，不刪欄、不改名、不動任何既有資料）：
--   1. 新增 product_groups 表：一個主商品群組一筆。
--   2. products 新增 4 個可為空／有預設值的欄位：
--        product_group_id  這個口味屬於哪一個主商品（NULL＝沒有分組，維持單一商品）
--        variant_name      口味／款式名稱（例：檸檬、蘆薈）
--        variant_sort      口味顯示順序
--        use_group_image   是否使用主商品共用圖片
--   3. order_items 新增 3 個名稱快照欄位，避免未來商品／口味改名後舊訂單內容跟著改變：
--        product_name_snapshot / variant_name_snapshot / specs_snapshot
--
-- 相容性：
--   - 舊商品 product_group_id 預設 NULL，商品管理／團購／LINE商品卡／LIFF／訂單全部維持原本單一商品行為。
--   - 舊訂單的 order_items 快照欄位為 NULL，前端沿用舊的即時查詢（見 customer-name.js 同類 fallback 邏輯），
--     新訂單一律由 Worker 寫入快照，不再需要即時查詢也能正確顯示。
--
-- 本檔可安全重跑的部分使用 IF NOT EXISTS／INSERT OR IGNORE；ALTER TABLE ADD COLUMN 不可重複執行
-- （SQLite 對已存在欄位會回 duplicate column name，這與既有 migration-007/008/009 的慣例一致）。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_product_groups_enabled ON product_groups(enabled);

ALTER TABLE products ADD COLUMN product_group_id TEXT REFERENCES product_groups(id);
ALTER TABLE products ADD COLUMN variant_name TEXT;
ALTER TABLE products ADD COLUMN variant_sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN use_group_image INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group_id, variant_sort);

ALTER TABLE order_items ADD COLUMN product_name_snapshot TEXT;
ALTER TABLE order_items ADD COLUMN variant_name_snapshot TEXT;
ALTER TABLE order_items ADD COLUMN specs_snapshot TEXT;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO schema_migrations (version, description)
VALUES ('011', 'product_groups + variant columns on products + order_items name snapshots');
