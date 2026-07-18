# 阿賢Easy購管理系統

這是一個專為夫妻兩人共同操作的輕量化團購管理系統。

## 特色功能

1. **首頁儀表板**：快速查看當前活動摘要，包含訂單總金額、未付款、未包貨等指標。
2. **團購活動管理**：建立與修改團購，支援一鍵複製前一團商品。
3. **商品管理**：管理商品清單、規格、價格，支援商品停用（防刪除）。
4. **客戶管理**：管理客戶暱稱、電話、地址。具備電話去格式重複判定與編號自動生成。
5. **訂單管理**：完整的新增、修改、取消訂單流程，支援自取/外送配送邏輯與批次狀態修改。
6. **依客戶整理與包貨核對**：依客戶暱稱整合其訂單明細，並提供商品包貨勾選，全部勾選後可一鍵完成包貨。
7. **依商品整理**：統計每樣商品的訂購總量，便於向廠商叫貨與點貨。
8. **Excel 匯入與匯出**：
   - 支援客戶、商品、訂單之 `.xlsx` 或 `.csv` 匯入，提供詳細的格式檢查與錯誤定位。
   - 支援訂單資料多行商品合併匯入。
   - 支援依團購活動匯出包含四個工作表（客戶訂購總表、客戶商品明細、商品數量統計、外送及自取名單）的完整 Excel 報表。

## 執行與開發

本系統為純前端單頁面應用程式 (SPA)，完全免安裝、免伺服器。

- **預覽方式**：在瀏覽器中直接開啟 `index.html` 即可使用。
- **資料保存**：所有資料均自動存儲於瀏覽器的 `localStorage` 中。

## 技術架構

- **核心**：HTML5, CSS3, JavaScript (ES6)
- **外部庫 (CDN)**：
  - **SheetJS (xlsx.full.min.js)**：用於 Excel 的解析與多工作表匯出。
  - **FontAwesome (CSS)**：系統圖示。

## LINE 完全靜默收單

LINE ID：`0923317559`。LINE Bot 僅作背景收單，不是客服機器人。後端只使用 LINE 的 Webhook 與群組成員資料查詢，不包含 Reply、Push、Broadcast、Multicast、Narrowcast 或任何排程通知 API。

### 架構與流程

1. LINE 將群組文字事件送至 Cloudflare Worker 的 `POST /webhooks/line`。
2. Worker 以原始 request body 驗證 `x-line-signature`，驗證成功後立即建立背景工作並回傳 HTTP 200。
3. 背景工作取得 groupId、userId、messageId、顯示名稱、原文與時間，完成 NFKC 全半形轉換、英文大寫及符號統一。
4. 解析商品代碼及數量，對照客戶綁定，寫入 D1 的 `line_order_inbox`。
5. `message_id` 是資料表主鍵，且採 `INSERT OR IGNORE`，LINE 重送不會重複寫入。
6. 相同群組、使用者、標準化內容在五分鐘內再次出現時只標示「疑似重複」，不刪除也不合併。
7. 管理者在「LINE 訂單收件匣」確認後，才以 D1 batch 原子操作建立正式 `orders` 與 `order_items`，並更新為「已轉正式訂單」。`orders.source_message_id` 另設 UNIQUE，避免同一收件資料被重複轉單。

### 部署設定

1. 建立 D1，將既有 customers/products 表與 `worker/schema.sql` migration 套用至資料庫。若既有資料表已經包含新增欄位，請將對應 `ALTER TABLE` 從 migration 移除後再執行。
2. 複製 `wrangler.toml.example` 為 `wrangler.toml`，填入 D1 database id。
3. 使用 `wrangler secret put LINE_CHANNEL_SECRET`、`wrangler secret put LINE_CHANNEL_ACCESS_TOKEN` 與 `wrangler secret put ADMIN_API_KEY` 儲存機密；不可放入前端或 Git。另將 `ADMIN_ORIGIN` 設為 `https://player5500-ctrl.github.io`，限制只有管理網站可跨來源存取 API。
4. 部署 Worker，將 LINE Developers 的 Webhook URL 設為 `https://<worker>/webhooks/line`。
5. 在後台「LINE 靜默收單設定」填入 Worker 根網址。LINE Developers 後台需關閉自動回覆訊息與加入好友歡迎訊息。

### 本機驗證

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```
