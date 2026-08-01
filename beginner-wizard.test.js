const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Wizard = require("./beginner-wizard.js");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const wizardSource = fs.readFileSync(path.join(__dirname, "beginner-wizard.js"), "utf8");
const buildSource = fs.readFileSync(path.join(__dirname, "scripts", "build.js"), "utf8");
const serviceWorkerSource = fs.readFileSync(path.join(__dirname, "service-worker.js"), "utf8");

test("新手商品與團購編號會沿用既有最大編號自動產生", () => {
    assert.equal(Wizard.nextCode("P", ["P001", "P009", "OTHER"]), "P010");
    assert.equal(Wizard.nextCode("GB", ["GB001", "GB015"]), "GB016");
});

test("進貨10、保留1，自動算出可以賣9", () => {
    assert.equal(Wizard.calculateSellable(10, 1), 9);
    assert.equal(Wizard.calculateSellable(1, 5), 0);
});

test("商品欄位顯示新手看得懂的錯誤訊息", () => {
    const errors = Wizard.validateProductDraft({
        name: "", pickupPrice: "", deliveryPrice: -1, unit: "", photo: "", hasFile: false
    });
    assert.equal(errors.name, "商品名稱還沒填寫");
    assert.equal(errors.photo, "請先選擇商品圖片");
    assert.match(errors.pickupPrice, /自取價/);
    assert.match(errors.deliveryPrice, /外送價/);
});

test("截止日期不得早於今天", () => {
    const errors = Wizard.validateGroupDraft({ name: "測試團", endDate: "2026-07-31" }, "2026-08-01");
    assert.equal(errors.endDate, "截止日期不能早於今天");
    assert.deepEqual(Wizard.validateGroupDraft({ name: "測試團", endDate: "2026-08-01" }, "2026-08-01"), {});
});

test("精靈草稿會記錄五步驟防重所需識別資料", () => {
    const draft = Wizard.createDraft();
    assert.equal(draft.step, 1);
    assert.equal(draft.completed, false);
    assert.deepEqual(draft.productIds, []);
    assert.deepEqual(draft.publishedProductIds, []);
    assert.equal(Wizard.STORAGE_KEY, "easygo_beginner_wizard");
});

test("已發布商品再次發布前必須辨識為重複發布", () => {
    assert.equal(Wizard.needsRepublishConfirmation(["P001"], "P001"), true);
    assert.equal(Wizard.needsRepublishConfirmation(["P001"], "P002"), false);
});

test("錯誤訊息不向新手顯示 API 原始錯誤內容", () => {
    const raw = { error: "SQLITE_CONSTRAINT", status: 500, details: { token: "secret" } };
    const message = Wizard.friendlyError(raw, "發布失敗，請稍後再試一次");
    assert.equal(message, "發布失敗，請稍後再試一次");
    assert.doesNotMatch(message, /SQL|Token|secret|Worker|API/i);
});

test("首頁有明顯入口與完整五步驟進度", () => {
    assert.match(html, /第一次開團，從這裡開始/);
    assert.match(html, /跟著步驟操作，不用熟悉電腦也能完成開團/);
    ["商品資料", "建立團購", "設定數量", "LINE 文案", "發布開團"].forEach(label => {
        assert.match(html, new RegExp(label));
    });
    assert.match(html, /繼續上次進度/);
    assert.match(html, /重新開始/);
    assert.match(html, /前往連線設定/);
});

test("精靈沿用現有資料與 API，沒有建立第二套資料表或端點", () => {
    assert.match(appSource, /window\.EasyGoApp/);
    assert.match(appSource, /syncProductToCloud/);
    assert.match(appSource, /\/api\/group-buys\//);
    assert.match(appSource, /\/api\/line\/flex-preview/);
    assert.match(appSource, /\/api\/line\/publish/);
    assert.match(wizardSource, /upsertLocalProduct/);
    assert.match(wizardSource, /upsertLocalGroup/);
    assert.match(wizardSource, /syncStock/);
    assert.match(wizardSource, /lineNote/);
});

test("LINE 文案步驟必須勾選完成，商品卡發布具備防重提醒", () => {
    assert.match(wizardSource, /我已經貼到 LINE 記事本/);
    assert.match(wizardSource, /請先勾選/);
    assert.match(wizardSource, /的訂購卡已經發布過，確定要再次發布嗎/);
    assert.match(wizardSource, /即將把商品訂購卡發布到 LINE 群組，確定要發布嗎/);
});

test("選擇商品圖片重新渲染前會先保留已輸入欄位", () => {
    const previewFunction = wizardSource.match(/function previewImage\([\s\S]*?\n    }/);
    assert.ok(previewFunction);
    assert.match(previewFunction[0], /rememberProducts\(\);/);
    assert.ok(previewFunction[0].indexOf("rememberProducts();") < previewFunction[0].indexOf("renderProducts();"));
});

test("建置與離線快取包含新手精靈模組", () => {
    assert.match(buildSource, /beginner-wizard\.js/);
    assert.match(serviceWorkerSource, /beginner-wizard\.js/);
    assert.match(serviceWorkerSource, /20260801-beginner-wizard-v7/);
    assert.match(html, /beginner-wizard\.js\?v=20260801-beginner-wizard/);
});
