# 阿賢 Easy 購

團購訂單管理網站，前端部署於 GitHub Pages；LINE 群組靜默收單由 Cloudflare Worker、D1 與 LINE Messaging API 處理。

## LINE Flex 商品卡＋靜默 Postback 收單

管理員可在「團購活動管理」按「發布到 LINE 群組」，先預覽商品卡，再由受保護的管理 API 呼叫 LINE Push API 發布。商品卡的 `1份／2份／3份／取消訂購` 都是 Postback Action，沒有 `displayText`。

客戶按鈕後，Webhook 只在 D1 transaction 內更新訂單、事件紀錄與異動紀錄，不呼叫 Reply、Push、Broadcast、Multicast 或 Narrowcast，因此群組聊天室不會產生新訊息。數量按鈕是「設定數量」而不是累加；價格只從 D1 `products` 查詢。

防重複規則：

- `line_webhook_events.webhook_event_id` 唯一。
- `orders(customer_id, group_buy_id)` 唯一。
- `order_items(order_id, product_id)` 唯一，等效於 `LINE userId + groupBuyId + productId` 只有一筆有效明細。
- 未綁定 LINE userId 會建立 `profile_status = pending` 的暫存客戶，不會因缺電話或地址丟單。

發布商品卡成功後，該 LINE 群組會綁定目前團購；後續文字 `+1` 人工確認匯入時，會寫入同一套 `orders/order_items`。若先文字訂 1 份再按 `3份`，最後數量為 3。

### 保留的文字收單

### 商品代碼

同一篇記事本的不同口味應建立成不同商品，`products.line_code` 使用共同前綴：

| 商品 | `line_code` |
|---|---|
| 臭豆腐－原味 | `P023-A` |
| 臭豆腐－辣味 | `P023-B` |

記事本請提示客人在群組聊天室留言：

```text
P023 A+3
P023 A+1 B+1
更正 P023 A+2
取消 P023
```

所有命令都先進入「LINE 訂單收件匣」，由管理員確認後才新增、更正或取消正式訂單。系統會依 `messageId` 與 `webhookEventId` 去重，並處理 LINE 收回訊息。

## Worker 部署

1. 建立 Cloudflare D1 資料庫。
2. 新資料庫執行 `worker/schema.sql`；舊版資料庫先備份，再依序執行 `worker/migration-002-line-commands.sql`、`worker/migration-003-products.sql`、`worker/migration-004-line-flex-postback.sql`、`worker/migration-005-liff-dual-price.sql`、`worker/migration-006-customer-address.sql`、`worker/migration-007-customer-display-name.sql`。
3. 建立商品圖片用的 R2 bucket：`npx wrangler r2 bucket create ah-hsien-easy-buy-images`。
4. 複製 `wrangler.toml.example` 為 `wrangler.toml`，填入 D1 `database_id`（R2 綁定 `IMAGES` 已含在範本內；未綁定時圖片上傳會回 503，其餘功能不受影響）。
5. 設定機密：

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put ADMIN_API_KEY
```

並在 `wrangler.toml` 的 `[vars]` 或 Cloudflare Dashboard 設定：

```toml
LINE_DEFAULT_GROUP_ID = ""
```

6. 部署 Worker，並把 LINE Developers 的 Webhook URL 設成：

```text
https://<worker-domain>/webhook/line
```

7. 在 LINE Developers 啟用 Webhook、Webhook redelivery，以及「Allow bot to join group chats」。
8. 關閉 Messaging API 的自動回覆訊息與加入好友歡迎訊息；Webhook 不需設定任何 Reply。
9. 網站固定連線 `https://ah-hsien-easy-buy-line.vannyai.workers.dev`；在「LINE 靜默收單設定」只輸入 `ADMIN_API_KEY`。

正式 migration 與部署命令（Windows PowerShell）：

```powershell
npx.cmd wrangler d1 execute ah-hsien-easy-buy --remote --file worker/migration-007-customer-display-name.sql
npx.cmd wrangler deploy
```

執行遠端 migration 前必須先在 Cloudflare 備份 D1；不要對已套用過的資料庫重複執行同一 migration 檔案
（`ALTER TABLE ADD COLUMN` 重複執行會回 `duplicate column name`）。

## 客戶名稱規則（migration-007 起）

LINE Bot 只用 `line_user_id`（`event.source.userId`）識別客戶，LINE 顯示名稱會變、會重複，不可作為識別碼。

| 欄位 | 用途 | 誰可以寫 |
| --- | --- | --- |
| `customers.id` | 客戶編號（例：`A001`、`024`），同時是訂單關聯鍵 | 團主 |
| `customers.line_user_id` | 唯一識別碼（UNIQUE） | LINE Webhook／綁定客戶 |
| `customers.line_display_name` | LINE 原始顯示名稱（例：蜜茶） | LINE Webhook／Postback／LIFF，每次收到訊息都可更新 |
| `customers.custom_display_name` | 團主手動設定的名稱（例：024-蜜茶） | 只有後台客戶管理／綁定客戶可寫，LINE 事件永不覆蓋 |
| `customers.nickname` | legacy 欄位，程式維護為「目前應顯示名稱」的鏡射值 | 由程式自動維護 |
| `orders` / `line_order_inbox` 的名稱欄位 | 下單當時的歷史名稱 snapshot | 只寫入，不作為顯示來源 |

顯示優先順序（實作於 `customer-name.js`，前後台共用同一份程式碼）：

```text
custom_display_name → line_display_name → legacy nickname → 訂單歷史名稱 → 未知客戶
```

重複客戶檢查（只讀，不改資料）：`worker/tools-duplicate-customer-check.sql`。

Channel Secret、Channel Access Token 與管理 API 金鑰不得寫入 GitHub Pages 或提交到 Git。

## 本機檢查

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

Webhook 本機驗簽與 Postback／D1 transaction 測試已包含在 `npm.cmd test`。真實 LINE 群組發布仍需有效的 Channel Access Token、Channel Secret、群組 ID，以及已套用 migration-007 的遠端 D1。
