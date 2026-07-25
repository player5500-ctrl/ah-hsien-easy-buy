const test = require("node:test");
const assert = require("node:assert/strict");
const CustomerName = require("./customer-name.js");

test("名稱優先順序：團主自訂 > LINE 原始 > legacy nickname > 訂單歷史 > 未知客戶", () => {
    assert.equal(CustomerName.resolveDisplayName({ custom_display_name: "024-蜜茶", line_display_name: "蜜茶", nickname: "蜜茶" }, "舊名"), "024-蜜茶");
    assert.equal(CustomerName.resolveDisplayName({ custom_display_name: null, line_display_name: "蜜茶" }, "舊名"), "蜜茶");
    assert.equal(CustomerName.resolveDisplayName({ nickname: "legacy 名稱" }, "舊名"), "legacy 名稱");
    assert.equal(CustomerName.resolveDisplayName({}, "訂單歷史名稱"), "訂單歷史名稱");
    assert.equal(CustomerName.resolveDisplayName({}, ""), "未知客戶");
    assert.equal(CustomerName.resolveDisplayName(null, null), "未知客戶");
});

test("案例五：清空團主自訂名稱後回退 LINE 原始名稱，不得出現空白/null/undefined", () => {
    for (const empty of ["", "   ", null, undefined]) {
        const resolved = CustomerName.resolveDisplayName({ custom_display_name: empty, line_display_name: "蜜茶" });
        assert.equal(resolved, "蜜茶");
    }
    assert.equal(CustomerName.resolveDisplayName({ custom_display_name: "", line_display_name: "", nickname: "" }), "未知客戶");
});

test("支援前端 camelCase 欄位（state.customers）", () => {
    assert.equal(CustomerName.resolveDisplayName({ customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶" }), "024-蜜茶");
    assert.equal(CustomerName.resolveDisplayName({ customDisplayName: null, lineDisplayName: "蜜茶" }), "蜜茶");
    assert.equal(CustomerName.hasCustomName({ customDisplayName: "024-蜜茶" }), true);
    assert.equal(CustomerName.hasCustomName({ customDisplayName: "  " }), false);
});

test("mirrorNickname 產生 legacy nickname 鏡射值", () => {
    assert.equal(CustomerName.mirrorNickname({ customDisplayName: "024-蜜茶", lineDisplayName: "蜜茶" }), "024-蜜茶");
    assert.equal(CustomerName.mirrorNickname({ customDisplayName: null, lineDisplayName: "蜜茶" }), "蜜茶");
    assert.equal(CustomerName.mirrorNickname({}, "A001"), "A001");
    assert.equal(CustomerName.mirrorNickname({}), "");
});

test("resolvedNameSql 不含『未知客戶』字面值（LEFT JOIN 無客戶時需為 NULL）", () => {
    const sql = CustomerName.resolvedNameSql("c");
    assert.match(sql, /c\.custom_display_name/);
    assert.match(sql, /c\.line_display_name/);
    assert.match(sql, /c\.nickname/);
    assert.equal(sql.includes("未知客戶"), false);
    assert.ok(sql.indexOf("custom_display_name") < sql.indexOf("line_display_name"));
    assert.ok(sql.indexOf("line_display_name") < sql.indexOf("c.nickname"));
});

test("CUSTOMER_UPSERT_SQL 絕不覆蓋 custom_display_name", () => {
    const sql = CustomerName.CUSTOMER_UPSERT_SQL;
    const updateClause = sql.slice(sql.indexOf("DO UPDATE SET"));
    assert.equal(/custom_display_name\s*=/.test(updateClause), false);
    assert.match(updateClause, /line_display_name\s*=/);
    assert.match(updateClause, /nickname\s*=/);
});
