// 客戶名稱解析（全系統唯一實作）
//
// 為什麼要有這個檔案：
//   LINE Bot 只能用 event.source.userId（line_user_id）識別客戶，LINE 顯示名稱會變、會重複，
//   絕對不能當識別碼；而「團主在客戶管理手動設定的名稱」必須永遠優先於 LINE 原始名稱顯示。
//   後台有 10 幾處顯示客戶名稱（訂單列表、訂單詳情、依客戶整理、列印、Excel…），
//   全部改成呼叫這裡的 resolveDisplayName()，避免只修好其中一頁。
//
// 名稱顯示優先順序：
//   1. custom_display_name  團主手動設定的名稱，例：024-蜜茶
//   2. line_display_name    LINE 原始顯示名稱，例：蜜茶
//   3. nickname             migration-007 之前的舊單一名稱欄位（向後相容）
//   4. snapshot             訂單／收件匣「下單當時」記錄的歷史名稱
//   5. 未知客戶
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.CustomerName = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const UNKNOWN = "未知客戶";

    function clean(value) {
        if (value === null || value === undefined) return "";
        return String(value).trim();
    }

    // 同時支援 snake_case（D1 資料列）與 camelCase（前端 state.customers）。
    function customFrom(customer) {
        return clean(customer.custom_display_name !== undefined ? customer.custom_display_name : customer.customDisplayName);
    }
    function lineFrom(customer) {
        return clean(customer.line_display_name !== undefined ? customer.line_display_name : customer.lineDisplayName);
    }

    function resolveDisplayName(customer, snapshot) {
        const row = customer || {};
        return customFrom(row) || lineFrom(row) || clean(row.nickname) || clean(snapshot) || UNKNOWN;
    }

    // 團主自訂名稱是否存在（清空後要回退 LINE 原始名稱，不可顯示空白／null／undefined）。
    function hasCustomName(customer) {
        return customFrom(customer || {}) !== "";
    }

    // 寫回 legacy customers.nickname 的鏡射值：舊查詢／舊前端仍讀 nickname，
    // 讓它永遠等於「目前應顯示的名稱」，避免新舊欄位不一致。
    function mirrorNickname(customer, fallback) {
        const row = customer || {};
        return customFrom(row) || lineFrom(row) || clean(row.nickname) || clean(fallback) || "";
    }

    // SQL 版本的同一組優先順序（不含「未知客戶」字面值：
    // LEFT JOIN 找不到客戶時要回 NULL，讓 JS 端能再回退訂單歷史名稱）。
    function resolvedNameSql(alias) {
        const prefix = alias ? `${alias}.` : "";
        return `COALESCE(NULLIF(TRIM(${prefix}custom_display_name), ''), NULLIF(TRIM(${prefix}line_display_name), ''), NULLIF(TRIM(${prefix}nickname), ''))`;
    }

    // 以 line_user_id upsert 客戶（LINE Webhook／商品卡 Postback／LIFF 共用）。
    // 關鍵：DO UPDATE SET 裡沒有 custom_display_name —— 團主手動設定的名稱永遠不會被 LINE 事件覆蓋。
    // 只更新 line_display_name（LINE 原始名稱）與 nickname 鏡射值。
    // 綁定參數順序：id, nickname(僅初次 INSERT 生效), line_display_name, line_user_id
    const CUSTOMER_UPSERT_SQL = `INSERT INTO customers
        (id, nickname, line_display_name, line_user_id, pickup_type, profile_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(line_user_id) DO UPDATE SET
            line_display_name = CASE WHEN TRIM(COALESCE(excluded.line_display_name, '')) <> ''
                THEN excluded.line_display_name ELSE customers.line_display_name END,
            nickname = COALESCE(
                NULLIF(TRIM(COALESCE(customers.custom_display_name, '')), ''),
                NULLIF(TRIM(COALESCE(CASE WHEN TRIM(COALESCE(excluded.line_display_name, '')) <> ''
                    THEN excluded.line_display_name ELSE customers.line_display_name END, '')), ''),
                customers.nickname),
            updated_at = CURRENT_TIMESTAMP`;

    return { UNKNOWN, resolveDisplayName, hasCustomName, mirrorNickname, resolvedNameSql, CUSTOMER_UPSERT_SQL };
});
