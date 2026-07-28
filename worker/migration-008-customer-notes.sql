-- migration-008: 客戶備註／本名 跨裝置保存
--
-- 問題：團主在「客戶管理」填的備註（多半就是客人的本名，例：005-小葉娃 → 家玲）只存在
--       瀏覽器 localStorage。換一台電腦／換瀏覽器／清快取就全部消失，
--       「快速貼上匯入」寫進去的本名也只留在當下那台裝置（雲端 D1 只有 nickname 鏡射值）。
--
-- 作法：新增一個可為空的欄位（additive，不刪除、不重建任何資料，不需回填）：
--   notes  團主自己記的備註／本名，由後台 PUT /api/customers 與批次匯入維護
--
-- 既有客戶的 notes 一律留 NULL：本機 localStorage 還有值的裝置，
-- 下次在客戶管理按「儲存」就會把備註 PUT 上雲端（雲端有值才會蓋回本機，見 app.js syncCustomersFromCloud）。
-- LINE Webhook／商品卡 Postback／LIFF 一律不寫這欄（那是團主的私人筆記，不是 LINE 資料）。
PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN notes TEXT;
