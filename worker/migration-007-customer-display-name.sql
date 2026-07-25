-- migration-007: 區分「LINE 原始名稱」與「團主自訂名稱」
--
-- 問題：customers 只有單一 nickname 欄位，LINE Webhook／商品卡 Postback／LIFF 每次收到訊息
--       都會把 LINE profile.displayName 寫回 nickname，覆蓋團主在客戶管理改好的「024-蜜茶」。
--
-- 作法：新增兩個可為空的欄位（additive，不刪除、不重建任何資料）：
--   line_display_name    LINE 原始顯示名稱，Webhook 可以每次更新
--   custom_display_name  團主手動設定的名稱，任何 LINE 事件都不得寫入
--
-- 客戶編號（例：024）沿用既有的 customers.id，不另建 customer_code 欄位，避免重複意義的欄位。
-- legacy nickname 欄位保留，之後由程式維護為「目前應顯示的名稱」鏡射值，舊查詢不會壞。
PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN line_display_name TEXT;
ALTER TABLE customers ADD COLUMN custom_display_name TEXT;

-- 回填 1：LINE 靜默收單／LIFF 自動建立的暫存客戶（id 為 LINE-xxxx 且 profile_status = 'pending'），
--         其 nickname 來自 LINE profile，屬於 LINE 原始名稱。
UPDATE customers
SET line_display_name = nickname
WHERE line_display_name IS NULL
  AND profile_status = 'pending'
  AND id LIKE 'LINE-%'
  AND TRIM(COALESCE(nickname, '')) <> '';

-- 回填 2：其餘客戶（團主在客戶管理建檔或已用「綁定客戶」指定過）的 nickname 是團主設定的名稱。
UPDATE customers
SET custom_display_name = nickname
WHERE custom_display_name IS NULL
  AND NOT (profile_status = 'pending' AND id LIKE 'LINE-%')
  AND TRIM(COALESCE(nickname, '')) <> '';

CREATE INDEX IF NOT EXISTS idx_customers_custom_display_name ON customers(custom_display_name);
