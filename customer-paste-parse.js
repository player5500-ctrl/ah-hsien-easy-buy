// 客戶「快速貼上匯入」文字解析＋客戶編號配號（全系統唯一實作）
//
// 為什麼要有這個檔案：
//   團主手上的客戶名冊常常是 LINE 群組裡直接複製出來的一行一位純文字，
//   例如「001號蔡清景 - 蔡清景」「005號家玲-小葉娃」。
//   把「編號／本名／LINE 名稱」的切法集中在這裡，
//   前端預覽表格、Worker 匯入端點與 node 測試共用同一份規則，避免三邊結果不一致。
//
// ⚠️ 欄位對應follows Vanny 手動建檔的既有慣例（2026-07-28 對照 production 前 7 筆確認）：
//   貼上的三碼編號       → **不是** customers.id，只是顯示名稱的前綴
//   customers.id         → 系統自動配號 A001／A002…（接續現有最大 A### 往下發）
//   custom_display_name  → `<編號>-<LINE暱稱>`，例：005-小葉娃、001-蔡清景
//   line_display_name    → LINE 暱稱（LINE 訊息比對靠這欄，不可省略）
//   nickname             → 本名（NOT NULL，向後相容用）
//   notes（僅前端 state） → 本名；D1 customers 沒有 notes 欄位
//
// ⚠️ 編號一律當「字串」處理："001" 只要被 Number() 解析過就會掉前導零而變成另一個編號。
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

    // ----------------------------------------------------------------------
    // 客戶編號（customers.id）配號：A001／A002…
    // Vanny 手動建檔的既有慣例是 A + 三碼流水號，貼上的 001 只是顯示名稱前綴。
    // 序號一律用「解析數字後比大小」，不可用字串比大小
    //（'A1000' < 'A999' 的字典序陷阱，破百之後就會發錯號）。
    // ----------------------------------------------------------------------
    const CUSTOMER_ID_PATTERN = /^A(\d+)$/;
    const CUSTOMER_ID_MIN_WIDTH = 3;

    function customerIdSequence(id) {
        const matched = String(id === null || id === undefined ? "" : id).trim().match(CUSTOMER_ID_PATTERN);
        if (!matched) return 0;
        const value = Number(matched[1]);
        return Number.isFinite(value) ? value : 0;
    }

    function formatCustomerId(sequence) {
        return `A${String(Math.max(1, Math.trunc(sequence))).padStart(CUSTOMER_ID_MIN_WIDTH, "0")}`;
    }

    function maxCustomerIdSequence(ids) {
        let max = 0;
        for (const id of ids || []) {
            const sequence = customerIdSequence(id);
            if (sequence > max) max = sequence;
        }
        return max;
    }

    // 單筆配號：現有最大 A### + 1；完全沒有 A### 時從 A001 開始。
    function nextCustomerId(ids) {
        return formatCustomerId(maxCustomerIdSequence(ids) + 1);
    }

    // 批次配號：同一批要連號（A008 → A009 → A010），
    // 且每次都再確認一次沒撞到既有 id（避免 A008／A0008 之類的意外重複）。
    function createCustomerIdAllocator(ids) {
        const taken = new Set();
        for (const id of ids || []) {
            const text = String(id === null || id === undefined ? "" : id).trim();
            if (text) taken.add(text);
        }
        let sequence = maxCustomerIdSequence(taken);
        return function allocate() {
            let candidate = "";
            do {
                sequence += 1;
                candidate = formatCustomerId(sequence);
            } while (taken.has(candidate));
            taken.add(candidate);
            return candidate;
        };
    }

    // 顯示名稱＝`<編號>-<LINE暱稱>`（例：005-小葉娃）。LINE 暱稱空白時退回只有編號。
    function buildCustomDisplayName(code, lineName) {
        const codeText = cleanField(code);
        const lineText = cleanField(lineName);
        if (!codeText) return lineText;
        return lineText ? `${codeText}-${lineText}` : codeText;
    }

    // 「已存在」判斷：既有客戶的 custom_display_name 是不是 `<編號>-` 開頭，
    // 或整串就等於這次要寫入的顯示名稱。編號本身不是 id，所以不能用 id 比對。
    function matchesCustomerCode(displayName, code) {
        const codeText = cleanField(code);
        if (!codeText) return false;
        const nameText = cleanField(displayName);
        if (!nameText) return false;
        return nameText.startsWith(`${codeText}-`) || nameText === codeText;
    }

    return {
        STATUS,
        REASON,
        parseCustomerPaste,
        parseCustomerPasteLine,
        padCustomerCode,
        customerIdSequence,
        formatCustomerId,
        maxCustomerIdSequence,
        nextCustomerId,
        createCustomerIdAllocator,
        buildCustomDisplayName,
        matchesCustomerCode
    };
});
