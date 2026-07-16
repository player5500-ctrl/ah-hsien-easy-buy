const test = require("node:test");
const assert = require("node:assert/strict");
const voice = require("./product-voice.js");

test("中文數字與規格轉換", () => {
    assert.equal(voice.chineseNumberToInteger("兩百"), 200);
    assert.equal(voice.chineseNumberToInteger("一百九十"), 190);
    assert.equal(voice.chineseNumberToInteger("一百五十"), 150);
    assert.equal(voice.chineseNumberToInteger("一千"), 1000);
    assert.equal(voice.chineseNumberToInteger("一千兩百五十"), 1250);
    assert.equal(voice.chineseNumberToInteger("六十"), 60);
    assert.equal(voice.normalizeSpecs("十二入"), "12入");
    assert.equal(voice.normalizeSpecs("三十顆裝"), "30顆裝");
});

test("完整商品語句解析", () => {
    assert.deepEqual(voice.parseProductSpeech("商品名稱手工蛋捲，規格原味十二入，售價兩百元，單位盒。"), {
        name: "手工蛋捲", specs: "原味／12入", price: 200, unit: "盒", priceError: false, missingFields: []
    });
    assert.equal(voice.parseProductSpeech("商品名稱阿賢特調冰紅茶，規格一千毫升，售價六十元，單位瓶。").specs, "1000ml");
    assert.deepEqual(voice.parseProductSpeech("商品名稱高麗菜水餃，規格三十顆裝，售價一百五十元，單位包。"), {
        name: "高麗菜水餃", specs: "30顆裝", price: 150, unit: "包", priceError: false, missingFields: []
    });
});

test("部分欄位與無法辨識售價", () => {
    const partial = voice.parseProductSpeech("商品名稱紅茶，售價六十元。");
    assert.equal(partial.name, "紅茶");
    assert.equal(partial.price, 60);
    assert.deepEqual(partial.missingFields, ["unit"]);
    const invalid = voice.parseProductSpeech("商品名稱紅茶，售價特價，單位杯。");
    assert.equal(invalid.price, null);
    assert.equal(invalid.priceError, true);
});

test("停止辨識會中止目前實例", () => {
    let aborted = false;
    class FakeRecognition { start() {} abort() { aborted = true; } }
    const recognizer = voice.createSpeechRecognizer({ Recognition: FakeRecognition, onResult() {}, onError() {}, onEnd() {} });
    assert.equal(recognizer.start(), true);
    recognizer.stop();
    assert.equal(aborted, true);
    assert.equal(recognizer.isActive(), false);
});
