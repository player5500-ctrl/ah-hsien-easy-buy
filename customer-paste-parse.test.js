// 客戶「快速貼上匯入」解析規則驗收。
// 重點：客戶編號永遠是字串（"001" ≠ 1），前導零不可掉。
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCustomerPaste, padCustomerCode, STATUS } = require("./customer-paste-parse.js");

function parseOne(line) {
    const { rows } = parseCustomerPaste(line);
    assert.equal(rows.length, 1, `應解析出 1 列：${JSON.stringify(line)}`);
    return rows[0];
}

test("案例一：有「號」字＋短橫線前後有空格", () => {
    const row = parseOne("001號蔡清景 - 蔡清景");
    assert.equal(row.code, "001");
    assert.equal(row.name, "蔡清景");
    assert.equal(row.lineName, "蔡清景");
    assert.equal(row.status, STATUS.OK);
    assert.equal(row.reason, "");
    assert.equal(row.raw, "001號蔡清景 - 蔡清景");
});

test("案例一之二：002號鄭雅蘭 - 鄭雅蘭", () => {
    const row = parseOne("002號鄭雅蘭 - 鄭雅蘭");
    assert.deepEqual([row.code, row.name, row.lineName], ["002", "鄭雅蘭", "鄭雅蘭"]);
});

test("案例二：有「號」字＋短橫線前後沒空格", () => {
    const row = parseOne("004號陳美娟-陳美娟");
    assert.deepEqual([row.code, row.name, row.lineName], ["004", "陳美娟", "陳美娟"]);
    assert.equal(row.status, STATUS.OK);
});

test("案例三：姓名與 LINE 名稱不同", () => {
    const row = parseOne("005號家玲-小葉娃");
    assert.deepEqual([row.code, row.name, row.lineName], ["005", "家玲", "小葉娃"]);
});

test("案例四：沒有「號」字也要能解析", () => {
    const row = parseOne("006洪敏玲-洪敏玲");
    assert.deepEqual([row.code, row.name, row.lineName], ["006", "洪敏玲", "洪敏玲"]);
    assert.equal(row.status, STATUS.OK);
});

test("案例五：客戶編號永遠是字串，前導零不可掉", () => {
    const row = parseOne("001號蔡清景 - 蔡清景");
    assert.equal(typeof row.code, "string");
    assert.equal(row.code, "001");
    assert.notEqual(row.code, 1);
    // 單碼／雙碼補到 3 碼；超過 3 碼原樣保留
    assert.equal(parseOne("1號測試 - 測試").code, "001");
    assert.equal(parseOne("12號測試 - 測試").code, "012");
    assert.equal(parseOne("0012號測試 - 測試").code, "0012");
    assert.equal(padCustomerCode("1"), "001");
    assert.equal(padCustomerCode("001"), "001");
    assert.equal(padCustomerCode("0012"), "0012");
    assert.equal(typeof padCustomerCode("7"), "string");
});

test("案例六：沒有短橫線時，LINE 名稱沿用姓名", () => {
    const row = parseOne("007號王小明");
    assert.deepEqual([row.code, row.name, row.lineName, row.status], ["007", "王小明", "王小明", STATUS.OK]);
    const noHao = parseOne("008王小華");
    assert.deepEqual([noHao.code, noHao.name, noHao.lineName], ["008", "王小華", "王小華"]);
});

test("案例七：短橫線後面留空 → LINE 名稱沿用姓名", () => {
    const row = parseOne("009號張三 - ");
    assert.deepEqual([row.code, row.name, row.lineName, row.status], ["009", "張三", "張三", STATUS.OK]);
});

test("案例八：空白行完全略過，不算錯誤", () => {
    const { rows } = parseCustomerPaste("\n001號蔡清景-蔡清景\n\n   \n　　\n002號鄭雅蘭-鄭雅蘭\n\n");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.code), ["001", "002"]);
    assert.ok(rows.every(r => r.status === STATUS.OK));
});

test("案例九：姓名空白 → status noname", () => {
    const row = parseOne("010號 - 小葉娃");
    assert.equal(row.code, "010");
    assert.equal(row.status, STATUS.NONAME);
    assert.equal(row.reason, "姓名空白");
    const onlyCode = parseOne("011");
    assert.equal(onlyCode.status, STATUS.NONAME);
    assert.equal(onlyCode.code, "011");
});

test("案例十：開頭不是數字 → status invalid", () => {
    const row = parseOne("蔡清景 - 蔡清景");
    assert.equal(row.status, STATUS.INVALID);
    assert.equal(row.reason, "資料格式錯誤");
    assert.equal(row.code, "");
    assert.equal(parseOne("A001-王小明").status, STATUS.INVALID);
});

test("案例十一：全形破折號與全形空白", () => {
    const fullWidthDash = parseOne("012號林小美－林小美");
    assert.deepEqual([fullWidthDash.code, fullWidthDash.name, fullWidthDash.lineName], ["012", "林小美", "林小美"]);
    const emDash = parseOne("013號林小美—阿美");
    assert.deepEqual([emDash.code, emDash.name, emDash.lineName], ["013", "林小美", "阿美"]);
    const enDash = parseOne("014號林小美–阿美");
    assert.deepEqual([enDash.code, enDash.name, enDash.lineName], ["014", "林小美", "阿美"]);
    // 全形空白包在前後與短橫線兩側都要清乾淨
    const fullWidthSpace = parseOne("　015號　王大明　－　大明　");
    assert.deepEqual([fullWidthSpace.code, fullWidthSpace.name, fullWidthSpace.lineName], ["015", "王大明", "大明"]);
    // 全形數字編號
    const fullWidthDigits = parseOne("０１６號陳小華-小華");
    assert.deepEqual([fullWidthDigits.code, fullWidthDigits.name, fullWidthDigits.lineName], ["016", "陳小華", "小華"]);
});

test("案例十二：正確與錯誤混排時，正確的列仍要解析出來供預覽", () => {
    const text = [
        "001號蔡清景 - 蔡清景",
        "這行沒有編號",
        "",
        "004號陳美娟-陳美娟",
        "010號 - 小葉娃",
        "006洪敏玲-洪敏玲"
    ].join("\r\n");
    const { rows } = parseCustomerPaste(text);
    assert.equal(rows.length, 5, "空白行不列入，其他 5 列都要出現在預覽");
    assert.deepEqual(rows.map(r => r.status), [STATUS.OK, STATUS.INVALID, STATUS.OK, STATUS.NONAME, STATUS.OK]);
    const ok = rows.filter(r => r.status === STATUS.OK);
    assert.deepEqual(ok.map(r => r.code), ["001", "004", "006"]);
    assert.deepEqual(ok.map(r => r.name), ["蔡清景", "陳美娟", "洪敏玲"]);
});

test("案例十三：CRLF／CR 換行都要切得開，空字串回空陣列", () => {
    assert.deepEqual(parseCustomerPaste("").rows, []);
    assert.deepEqual(parseCustomerPaste(null).rows, []);
    assert.equal(parseCustomerPaste("001號甲-甲\r002號乙-乙").rows.length, 2);
});
