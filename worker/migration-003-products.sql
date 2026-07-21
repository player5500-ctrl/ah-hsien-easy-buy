-- migration-003: 商品表補齊價格/描述/圖片欄位（階段1）
ALTER TABLE products ADD COLUMN price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN description TEXT;
ALTER TABLE products ADD COLUMN image_url TEXT;
ALTER TABLE products ADD COLUMN updated_at TEXT;
