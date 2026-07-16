(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.ProductVoice = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const DIGITS = { "零": 0, "〇": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
    const SMALL_UNITS = { "十": 10, "百": 100, "千": 1000 };
    const FIELD_MARKERS = {
        name: ["商品名稱", "品名"],
        specs: ["規格", "尺寸", "包裝", "內容"],
        price: ["售價", "價格", "金額", "賣"],
        unit: ["計價單位", "單位"]
    };

    function chineseNumberToInteger(value) {
        if (!value || !/^[零〇一二兩三四五六七八九十百千萬]+$/.test(value)) return null;
        let total = 0;
        let section = 0;
        let number = 0;
        for (const char of value) {
            if (Object.prototype.hasOwnProperty.call(DIGITS, char)) {
                number = DIGITS[char];
            } else if (char === "萬") {
                section += number;
                total += (section || 1) * 10000;
                section = 0;
                number = 0;
            } else {
                const unit = SMALL_UNITS[char];
                section += (number || 1) * unit;
                number = 0;
            }
        }
        return total + section + number;
    }

    function convertChineseNumbers(text) {
        return String(text || "").replace(/[零〇一二兩三四五六七八九十百千萬]+/g, token => {
            const value = chineseNumberToInteger(token);
            return value === null ? token : String(value);
        });
    }

    function normalizeSpecs(value) {
        let result = convertChineseNumbers(value).replace(/毫升/gi, "ml").replace(/公升/gi, "L").trim();
        result = result.replace(/([^\d\s／/])\s*(\d+\s*(?:入|顆|個|片|包|盒|瓶|袋|箱|組|份|罐|杯|台|公斤|台斤|ml|L))/i, "$1／$2");
        return result;
    }

    function parsePrice(value) {
        const normalized = convertChineseNumbers(String(value || "").replace(/NT\$|新臺幣|台幣|元|塊/gi, "").trim());
        const match = normalized.match(/-?\d+(?:\.\d+)?/);
        if (!match) return null;
        const price = Number(match[0]);
        return Number.isFinite(price) && price >= 0 ? price : null;
    }

    function parseProductSpeech(transcript) {
        const raw = String(transcript || "").replace(/[，,、；;]/g, " ").replace(/[。！？!?]/g, " ").replace(/\s+/g, " ").trim();
        const markerEntries = Object.entries(FIELD_MARKERS).flatMap(([field, markers]) => markers.map(marker => ({ field, marker })));
        markerEntries.sort((a, b) => b.marker.length - a.marker.length);
        const markerPattern = markerEntries.map(entry => entry.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        const regex = new RegExp(`(${markerPattern})`, "g");
        const matches = [...raw.matchAll(regex)];
        const parsed = { name: "", specs: "", price: null, unit: "", priceError: false, missingFields: [] };

        matches.forEach((match, index) => {
            const marker = markerEntries.find(entry => entry.marker === match[0]);
            if (!marker || parsed[marker.field]) return;
            const start = match.index + match[0].length;
            const end = index + 1 < matches.length ? matches[index + 1].index : raw.length;
            const value = raw.slice(start, end).trim();
            if (marker.field === "price") {
                parsed.price = parsePrice(value);
                parsed.priceError = Boolean(value) && parsed.price === null;
            } else if (marker.field === "specs") {
                parsed.specs = normalizeSpecs(value);
            } else {
                parsed[marker.field] = value;
            }
        });

        parsed.missingFields = ["name", "price", "unit"].filter(field => field === "price" ? parsed.price === null : !parsed[field]);
        return parsed;
    }

    function createSpeechRecognizer(options) {
        const Recognition = options.Recognition;
        let recognition = null;
        return {
            isSupported: Boolean(Recognition),
            start() {
                if (!Recognition || recognition) return false;
                recognition = new Recognition();
                recognition.lang = "zh-TW";
                recognition.interimResults = false;
                recognition.continuous = false;
                recognition.onresult = event => options.onResult(event.results[0][0].transcript);
                recognition.onerror = event => { options.onError(event.error); this.stop(); };
                recognition.onend = () => { recognition = null; options.onEnd(); };
                recognition.start();
                return true;
            },
            stop() {
                if (!recognition) return;
                const active = recognition;
                recognition = null;
                active.abort();
            },
            isActive() { return Boolean(recognition); }
        };
    }

    return { chineseNumberToInteger, convertChineseNumbers, normalizeSpecs, parsePrice, parseProductSpeech, createSpeechRecognizer };
});
