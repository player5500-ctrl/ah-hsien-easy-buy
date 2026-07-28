-- 阿賢Easy購：批次新增 5 筆客戶（2026-07-28）
-- 安全性：INSERT OR IGNORE → 若編號已存在則完全不動原資料（不覆蓋、不報錯）
-- 欄位對應：id=客戶編號(字串保留前導零) / custom_display_name=客戶姓名 / line_display_name=LINE名稱
--            nickname=客戶姓名（NOT NULL 相容） / line_user_id 留 NULL（待 LINE 綁定）
INSERT OR IGNORE INTO customers (id, nickname, custom_display_name, line_display_name, profile_status, created_at, updated_at)
VALUES
  ('001','蔡清景','蔡清景','蔡清景','complete',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('002','鄭雅蘭','鄭雅蘭','鄭雅蘭','complete',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('004','陳美娟','陳美娟','陳美娟','complete',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('005','家玲','家玲','小葉娃','complete',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('006','洪敏玲','洪敏玲','洪敏玲','complete',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

-- 驗證：應列出 001,002,004,005,006
SELECT id, custom_display_name AS 姓名, line_display_name AS LINE名稱, profile_status
FROM customers WHERE id IN ('001','002','004','005','006') ORDER BY id;
