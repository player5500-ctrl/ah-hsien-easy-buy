# 阿賢 Easy 購

團購訂單管理網站，前端部署於 GitHub Pages；LINE 群組靜默收單由 Cloudflare Worker、D1 與 LINE Messaging API 處理。

## LINE 靜默收單

LINE 官方帳號加入群組後，Worker 只接收群組聊天室的新訊息，不會傳送 Reply、Push、Broadcast、Multicast 或 Narrowcast 訊息。

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
2. 新資料庫執行 `worker/schema.sql`；舊版資料庫先備份，再執行 `worker/migration-002-line-commands.sql`。
3. 複製 `wrangler.toml.example` 為 `wrangler.toml`，填入 D1 `database_id`。
4. 設定機密：

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put ADMIN_API_KEY
```

5. 部署 Worker，並把 LINE Developers 的 Webhook URL 設成：

```text
https://<worker-domain>/webhook/line
```

6. 在 LINE Developers 啟用 Webhook、Webhook redelivery，以及「Allow bot to join group chats」。
7. 網站固定連線 `https://ah-hsien-easy-buy-line.vannyai.workers.dev`；在「LINE 靜默收單設定」只輸入 `ADMIN_API_KEY`。

Channel Secret、Channel Access Token 與管理 API 金鑰不得寫入 GitHub Pages 或提交到 Git。

## 本機檢查

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```
