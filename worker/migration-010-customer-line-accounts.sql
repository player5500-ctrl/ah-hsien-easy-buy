-- migration-010: 一位客戶可綁定多個 LINE 帳號（customer_line_accounts 對照表）
--
-- 問題：customers.line_user_id 是 TEXT UNIQUE，一位客戶只能綁一個 LINE 帳號。
--       實際客人（例：A001／024-蜜茶）會用第二支手機／第二個 LINE 帳號下單，
--       第二個帳號只能自動建立 LINE-xxxx 暫存客戶，同一個人的訂單被拆成兩位客戶。
--
-- 作法：新增一張對照表（additive，不刪欄、不改名、不重建任何資料）：
--   customer_line_accounts  line_user_id（主鍵）→ customer_id，多個帳號指向同一位客戶
--   customers.line_user_id  保留不動（legacy 相容欄位，語意變成「第一個綁定的帳號」），
--                           不移除、不解除 UNIQUE，舊查詢與舊前端不會壞。
--
-- 查找規則（Worker 端唯一實作見 worker/src/customer-accounts.js）：
--   先查 customer_line_accounts，查不到再回退 customers.line_user_id（尚未回填的舊資料）。
-- 綁定規則：收件匣「綁定客戶」是「新增一個帳號」而不是「換綁」；
--   customers.line_user_id 只在客戶還沒有帳號時才填（第一個帳號填 legacy 欄位）。
--
-- 回填：把既有 customers.line_user_id 全部搬進對照表（INSERT OR IGNORE，本檔可安全重跑）。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customer_line_accounts (
  line_user_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  line_display_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cla_customer ON customer_line_accounts(customer_id);

INSERT OR IGNORE INTO customer_line_accounts (line_user_id, customer_id, line_display_name)
SELECT line_user_id, id, line_display_name FROM customers WHERE line_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO schema_migrations (version, description)
VALUES ('010', 'customer multi LINE accounts mapping table');
