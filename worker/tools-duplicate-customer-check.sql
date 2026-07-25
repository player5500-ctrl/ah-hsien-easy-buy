-- 重複客戶檢查（只讀，不修改任何資料）
--
-- 用途：migration-007 之後，確認同一個人是否被建成兩筆客戶。
-- 執行：npx wrangler d1 execute ah-hsien-easy-buy --remote --file worker/tools-duplicate-customer-check.sql
--
-- 合併策略（請勿直接 DELETE 有訂單的客戶）：
--   1. 後台「LINE 訂單收件匣」→「綁定客戶」選擇要保留的正式客戶編號，
--      系統會自動把 LINE-xxxx 暫存客戶的訂單移轉過去，再移除暫存客戶列
--      （見 worker/src/index.js 的 /api/line-inbox/:id/bind-customer）。
--   2. 若同一團購兩邊都已有訂單，會回 409；請先在訂單管理把其中一張訂單處理掉再綁定。
--   3. line_user_id 已有 UNIQUE 限制，同一個 LINE 帳號不可能再產生第二筆客戶。

-- A. LINE 自動建立的暫存客戶（尚未由團主綁定／補資料）
SELECT 'pending_auto_customer' AS issue, id, line_user_id, line_display_name, custom_display_name, nickname
FROM customers
WHERE profile_status = 'pending' AND id LIKE 'LINE-%'
ORDER BY id;

-- B. 顯示名稱相同但客戶編號不同（可能是同一人被建了兩筆）
SELECT 'same_display_name' AS issue, a.id AS keep_candidate, b.id AS duplicate_candidate,
       COALESCE(NULLIF(TRIM(a.custom_display_name), ''), NULLIF(TRIM(a.line_display_name), ''), a.nickname) AS display_name,
       a.line_user_id AS a_line_user_id, b.line_user_id AS b_line_user_id
FROM customers a
JOIN customers b ON b.id > a.id
  AND COALESCE(NULLIF(TRIM(a.custom_display_name), ''), NULLIF(TRIM(a.line_display_name), ''), a.nickname)
    = COALESCE(NULLIF(TRIM(b.custom_display_name), ''), NULLIF(TRIM(b.line_display_name), ''), b.nickname)
ORDER BY display_name;

-- C. 每筆客戶的訂單數（判斷可否安全移除哪一邊）
SELECT 'order_count' AS issue, c.id,
       COALESCE(NULLIF(TRIM(c.custom_display_name), ''), NULLIF(TRIM(c.line_display_name), ''), c.nickname) AS display_name,
       c.line_user_id, COUNT(o.id) AS order_count
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id ORDER BY order_count DESC, c.id;
