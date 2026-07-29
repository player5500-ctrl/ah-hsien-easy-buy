// 多 LINE 帳號 → 單一客戶 對照（migration-010：customer_line_accounts）
//
// 為什麼要有這個檔案：
//   customers.line_user_id 是 UNIQUE，一位客戶只能綁一個 LINE 帳號；實際客人（例：A001／024-蜜茶）
//   會用第二個 LINE 帳號下單，第二個帳號只能自動建立 LINE-xxxx 暫存客戶，同一個人被拆成兩位。
//   migration-010 之後改用 customer_line_accounts 對照表：多個 line_user_id 指向同一個 customer_id。
//
// 查找規則（全 Worker 唯一實作，processPostback／webhook findCustomer／LIFF resolveCustomer 共用）：
//   1. customer_line_accounts 對照表（一位客戶可多帳號）
//   2. 回退 customers.line_user_id（migration-010 尚未套用、或尚未回填的舊資料）
//
// 容錯：customer_line_accounts 表還不存在（migration-010 還沒跑）時，一律靜默回退 legacy 行為，
// Worker 新版程式先部署也不會爆；但要享受「一客多帳號」必須先套用 migration-010。
const CustomerName = require("../../customer-name.js");

const CUSTOMER_COLUMNS = "id, nickname, line_display_name, custom_display_name, line_user_id, pickup_type, address, profile_status";

function isMissingTableError(error) {
    return /no such table:?\s*customer_line_accounts/i.test(error && error.message ? error.message : "");
}

// 「表已存在」快取：只快取 true（表建立後不會消失）；false 不快取，
// migration 補套用後同一個 Worker isolate 立即生效，測試之間也不會互相污染。
const availableCache = new WeakSet();

async function lineAccountsTableAvailable(env) {
    if (availableCache.has(env.DB)) return true;
    try {
        // 一律先 bind() 再 first()：真實 D1 與各測試替身都支援這條路徑。
        await env.DB.prepare("SELECT 1 FROM customer_line_accounts LIMIT 1").bind().first();
        availableCache.add(env.DB);
        return true;
    } catch (error) {
        if (isMissingTableError(error)) return false;
        throw error;
    }
}

// line_user_id → 客戶（回傳 customers 資料列的固定欄位超集，找不到回 null）。
async function findCustomerByLineUserId(env, lineUserId) {
    const userId = String(lineUserId || "").trim();
    if (!userId) return null;
    try {
        const viaAccounts = await env.DB.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers
            WHERE id = (SELECT customer_id FROM customer_line_accounts WHERE line_user_id = ? LIMIT 1) LIMIT 1`)
            .bind(userId).first();
        if (viaAccounts) return viaAccounts;
    } catch (error) {
        if (!isMissingTableError(error)) throw error;
    }
    return env.DB.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE line_user_id = ? LIMIT 1`).bind(userId).first();
}

// 對照表 upsert：只更新 LINE 原始名稱，永不搬動 customer_id——
// 改綁（把帳號換到另一位客戶）只能走後台 bind-customer 端點，LINE 事件不得自動改綁。
function accountLinkStatement(env, lineUserId, customerId, lineDisplayName) {
    const name = String(lineDisplayName || "").trim();
    return env.DB.prepare(`INSERT INTO customer_line_accounts (line_user_id, customer_id, line_display_name)
        VALUES (?, ?, ?)
        ON CONFLICT(line_user_id) DO UPDATE SET
            line_display_name = CASE WHEN TRIM(COALESCE(excluded.line_display_name, '')) <> ''
                THEN excluded.line_display_name ELSE customer_line_accounts.line_display_name END`)
        .bind(lineUserId, customerId, name || null);
}

// LINE 事件（商品卡 Postback／LIFF）觸及客戶時要跑的 statements：
//   - 尚無客戶、或該帳號就是 legacy 欄位記的那個帳號 → 沿用 CUSTOMER_UPSERT_SQL
//     （建立暫存客戶／更新 LINE 原始名稱；團主自訂名稱永不被覆蓋）。
//   - 客戶是經 customer_line_accounts（第 2 個以上帳號）解析而來 → 不可跑 CUSTOMER_UPSERT_SQL：
//     INSERT 會撞 customers.id 主鍵（ON CONFLICT 目標是 line_user_id，救不到），
//     也不可覆蓋 legacy line_user_id（那是第一個帳號）；只更新對照表列的 LINE 名稱。
//   - 對照表存在時一律補寫該帳號的對照列（含 legacy 舊資料的「摸到就回填」）。
// 回傳的 statements 必須放在同一個 D1 batch 的最前面（暫存客戶要先 INSERT，對照列 FK 才成立）。
async function customerTouchStatements(env, { customerId, existingCustomer, lineUserId, lineDisplayName }) {
    const name = String(lineDisplayName || "").trim();
    const statements = [];
    if (!existingCustomer || existingCustomer.line_user_id === lineUserId) {
        statements.push(env.DB.prepare(CustomerName.CUSTOMER_UPSERT_SQL)
            .bind(customerId, name || "LINE 客戶", name || null, lineUserId));
    }
    if (await lineAccountsTableAvailable(env)) {
        statements.push(accountLinkStatement(env, lineUserId, customerId, name));
    }
    return statements;
}

module.exports = {
    lineAccountsTableAvailable,
    findCustomerByLineUserId,
    accountLinkStatement,
    customerTouchStatements,
    isMissingTableError
};
