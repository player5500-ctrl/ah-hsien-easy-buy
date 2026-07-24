-- migration-005: LINE LIFF 客戶端下單 — 商品雙價（自取價／外送價）
-- 僅新增可為空的欄位並回填，不刪除、不重建既有資料；保留 legacy `price` 欄位以維持相容。
-- 有效價格選擇規則：
--   自取 → COALESCE(pickup_price, price)
--   外送 → COALESCE(delivery_price, price)
PRAGMA foreign_keys = ON;

ALTER TABLE products ADD COLUMN pickup_price INTEGER;
ALTER TABLE products ADD COLUMN delivery_price INTEGER;

-- 回填：既有商品沿用原單一價，避免出現 NULL 導致前台顯示空白。
UPDATE products SET pickup_price = price WHERE pickup_price IS NULL;
UPDATE products SET delivery_price = price WHERE delivery_price IS NULL;
