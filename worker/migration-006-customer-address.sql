-- migration-006: LINE LIFF 客戶端下單 — 客戶外送地址
-- 僅新增可為空的欄位（additive），不刪除、不重建既有資料，不需回填。
-- 外送訂單需先設定地址；地址屬客戶私有資料，只回傳給經驗證的本人。
PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN address TEXT;
