(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.LineOrder = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const STATUSES = ["已接收", "已解析", "待綁定", "待確認", "格式錯誤", "疑似重複", "已轉正式訂單", "已忽略"];

    function normalizeMessage(value) {
        return String(value || "")
            .normalize("NFKC")
            .toUpperCase()
            .replace(/[×✕✖＊*]/g, "X")
            .replace(/[＋]/g, "+")
            .replace(/[，、；;｜|／/]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function parseMessage(value, productCodes) {
        const normalized = normalizeMessage(value);
        if (!normalized) return { normalized, items: [], status: "待確認", errorReason: "留言內容為空" };
        const knownCodes = new Set((productCodes || []).map(code => String(code).toUpperCase()));
        const tokens = normalized.split(/\s+/).filter(Boolean);
        const items = [];
        let incomplete = false;
        for (const token of tokens) {
            let match = null;
            if (knownCodes.size) {
                const code = [...knownCodes].sort((a, b) => b.length - a.length).find(candidate => {
                    const suffix = token.slice(candidate.length);
                    return token.startsWith(candidate) && /^(?:(?:\+|X)?\d+)?$/.test(suffix);
                });
                if (code) {
                    const suffix = token.slice(code.length).replace(/^(?:\+|X)/, "");
                    match = [token, code, suffix || undefined];
                }
            } else {
                match = token.match(/^([A-Z][A-Z0-9_-]*?)(?:\s*(?:\+|X)?\s*(\d+))?$/);
            }
            if (!match) {
                const unknown = token.match(/^([A-Z][A-Z0-9_-]*?)(?:[+X]?\d+)?$/);
                if (knownCodes.size && unknown) {
                    return { normalized, items: [], status: "格式錯誤", errorReason: `商品代碼不存在：${unknown[1]}` };
                }
                incomplete = true;
                continue;
            }
            const code = match[1];
            const quantity = match[2] ? Number(match[2]) : 1;
            if (knownCodes.size && !knownCodes.has(code)) {
                return { normalized, items: [], status: "格式錯誤", errorReason: `商品代碼不存在：${code}` };
            }
            items.push({ productCode: code, quantity });
        }
        if (!items.length || incomplete) {
            return { normalized, items, status: "待確認", errorReason: "留言格式不完整" };
        }
        return { normalized, items, status: "已解析", errorReason: "" };
    }

    function isSuspectedDuplicate(current, existing) {
        const when = Date.parse(current.messageTime);
        return (existing || []).some(item =>
            item.messageId !== current.messageId &&
            item.groupId === current.groupId &&
            item.lineUserId === current.lineUserId &&
            item.normalizedMessage === current.normalizedMessage &&
            Math.abs(when - Date.parse(item.messageTime)) <= 5 * 60 * 1000
        );
    }

    return { STATUSES, normalizeMessage, parseMessage, isSuspectedDuplicate };
});
