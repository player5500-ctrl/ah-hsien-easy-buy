// 客戶「快速貼上匯入」文字解析（全系統唯一實作）
//
// 為什麼要有這個檔案：
//   團主手上的客戶名冊常常是 LINE 群組裡直接複製出來的一行一位純文字，
//   例如「001號蔡清景 - 蔡清景」「006洪敏玲-洪敏玲」。
//   把「編號／團主設定名稱／LINE 名稱」的切法集中在這裡，
//   前端預覽表格與 node 測試共用同一份規則，避免兩邊解析結果不一致。
//
// 欄位對應（與 D1 customers 一致）：
//   客戶編號      → customers.id              （字串，永遠不轉數字；不足 3 位補前導零）
//   客戶姓名      → custom_display_name       （團主設定名稱，顯示優先權最高）＋鏡射寫入 nickname
//   LINE 名稱／暱稱 → line_display_name
//
// ⚠️ 客戶編號一律當「字串」處理：production 既有編號有 A001／LINE-<hash>，
//    這次匯入的是純三碼 001 系列；只要被 Number() 解析過就會掉前導零而變成另一個客戶。
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.CustomerPasteParse = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // 可接受的分隔線：半形 -、各式全形／破折號（－ ‐ ‑ ‒ – — ―）。
    const DASH_PATTERN = /[-‐‑‒–—―－]/;
    // 全形空白（U+3000）與 NBSP 也要當空白處理，否則 trim() 清不掉。
    const SPACE_PATTERN = /[　 ﻿]/g;
    // 全形數字０-９也要能當客戶編號。
    const FULLWIDTH_DIGITS = /[０-９]/g;
    // 開頭數字（可帶「號」字，也可以沒有）。
    const LEADING_CODE_PATTERN = /^(\d+)\s*號?\s*([\s\S]*)$/;

    const STATUS = { OK: "ok", INVALID: "invalid", NONAME: "noname" };
    const REASON = {
        [STATUS.OK]: "",
        [STATUS.INVALID]: "資料格式錯誤",
        [STATUS.NONAME]: "姓名空白"
    };

    function normalizeSpaces(value) {
        return String(value === null || value === undefined ? "" : value).replace(SPACE_PATTERN, " ");
    }

    function cleanField(value) {
        return normalizeSpaces(value).trim();
    }

    function toAsciiDigits(value) {
        return String(value).replace(FULLWIDTH_DIGITS, ch => String(ch.charCodeAt(0) - 0xFF10));
    }

    // 補成 3 碼；已經 3 碼以上就原樣保留（"0012" 不可截斷）。永遠回傳字串。
    function padCustomerCode(code) {
        const text = String(code === null || code === undefined ? "" : code).trim();
        if (!text) return "";
        return text.length >= 3 ? text : text.padStart(3, "0");
    }

    function makeRow(raw, code, name, lineName, status) {
        return { raw, code, name, lineName, status, reason: REASON[status] };
    }

    function parseCustomerPasteLine(line) {
        const raw = String(line === null || line === undefined ? "" : line);
        const work = cleanField(raw);
        if (!work) return null; // 空白行直接略過，不算錯誤

        const matched = toAsciiDigits(work).match(LEADING_CODE_PATTERN);
        if (!matched) return makeRow(raw, "", "", "", STATUS.INVALID);

        const code = padCustomerCode(matched[1]);
        const rest = cleanField(matched[2]);

        let name = rest;
        let lineName = "";
        const dashAt = rest.search(DASH_PATTERN);
        if (dashAt > -1) {
            name = cleanField(rest.slice(0, dashAt));
            lineName = cleanField(rest.slice(dashAt + 1));
        }
        // 沒有短橫線、或短橫線後面是空的：LINE 名稱沿用姓名（合理的預設值）。
        if (!lineName) lineName = name;

        if (!name) return makeRow(raw, code, "", "", STATUS.NONAME);
        return makeRow(raw, code, name, lineName, STATUS.OK);
    }

    // 主要進入點：多行文字 → { rows: [{ raw, code, name, lineName, status, reason }] }
    function parseCustomerPaste(text) {
        const source = String(text === null || text === undefined ? "" : text);
        const rows = [];
        for (const line of source.split(/\r\n|\r|\n/)) {
            const row = parseCustomerPasteLine(line);
            if (row) rows.push(row);
        }
        return { rows };
    }

    return { STATUS, REASON, parseCustomerPaste, parseCustomerPasteLine, padCustomerCode };
});
