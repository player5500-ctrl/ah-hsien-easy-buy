(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.LineOrder = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const STATUS = Object.freeze({
        PENDING: "待處理",
        READY: "可匯入",
        CUSTOMER_UNMATCHED: "待配對客戶",
        INCOMPLETE: "格式不完整",
        UNKNOWN_PRODUCT: "未知商品",
        DUPLICATE: "疑似重複",
        IMPORTED: "已轉正式訂單",
        IGNORED: "已忽略",
        CANCELLED: "已取消"
    });
    const STATUSES = Object.freeze(Object.values(STATUS));

    function normalizeMessage(value) {
        return String(value || "")
            .normalize("NFKC")
            .toUpperCase()
            .replace(/[×＊*]/g, "X")
            .replace(/[＋]/g, "+")
            .replace(/[，、；;｜|]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function result(normalized, items, status, errorReason = "", action = "create", targetProductPrefix = "") {
        return { normalized, items, status, errorReason, action, targetProductPrefix };
    }

    function catalogInfo(productCodes) {
        const codes = [...new Set((productCodes || []).map(code => String(code).normalize("NFKC").toUpperCase()).filter(Boolean))];
        return { codes, known: new Set(codes) };
    }

    function productExists(prefix, catalog) {
        return catalog.codes.some(code => code === prefix || code.startsWith(`${prefix}-`));
    }

    function resolveVariant(base, variant, catalog) {
        const dashed = `${base}-${variant}`;
        const compact = `${base}${variant}`;
        if (!catalog.codes.length || catalog.known.has(dashed)) return dashed;
        if (catalog.known.has(compact)) return compact;
        return "";
    }

    function parseDirectToken(token, catalog) {
        const sorted = [...catalog.codes].sort((a, b) => b.length - a.length);
        for (const code of sorted) {
            if (!token.startsWith(code)) continue;
            const suffix = token.slice(code.length);
            if (!suffix) return { productCode: code, quantity: 1 };
            const quantityMatch = suffix.match(/^(?:\+|X)?(\d+)$/);
            if (quantityMatch) return { productCode: code, quantity: Number(quantityMatch[1]) };
        }
        if (!catalog.codes.length) {
            const match = token.match(/^([A-Z][A-Z0-9_-]*?)(?:\+|X)?(\d+)?$/);
            if (match) return { productCode: match[1], quantity: match[2] ? Number(match[2]) : 1 };
        }
        return null;
    }

    function parseMessage(value, productCodes) {
        const normalized = normalizeMessage(value);
        if (!normalized) return result(normalized, [], STATUS.INCOMPLETE, "沒有可解析的文字");

        let body = normalized;
        let action = "create";
        if (/^更正(?:\s|$)/.test(body)) {
            action = "replace";
            body = body.replace(/^更正\s*/, "");
        } else if (/^取消(?:\s|$)/.test(body)) {
            action = "cancel";
            body = body.replace(/^取消\s*/, "");
        }

        const catalog = catalogInfo(productCodes);
        const tokens = body.split(/\s+/).filter(Boolean);
        if (!tokens.length) return result(normalized, [], STATUS.INCOMPLETE, "缺少商品代碼", action);

        if (action === "cancel") {
            const prefix = tokens[0].replace(/-(?:[A-Z][A-Z0-9_-]*)$/, "");
            if (!/^[A-Z][A-Z0-9_-]*$/.test(prefix)) return result(normalized, [], STATUS.INCOMPLETE, "取消格式應為：取消 P023", action);
            if (catalog.codes.length && !productExists(prefix, catalog)) return result(normalized, [], STATUS.UNKNOWN_PRODUCT, `找不到商品：${prefix}`, action, prefix);
            return result(normalized, [], STATUS.READY, "", action, prefix);
        }

        const items = [];
        const first = tokens[0];
        const firstIsBase = /^[A-Z][A-Z0-9_-]*$/.test(first) && productExists(first, catalog);
        const variantTokens = tokens.slice(1);
        const hasVariantSyntax = variantTokens.length > 0 && variantTokens.every(token => /^[A-Z][A-Z0-9_-]*(?:\+|X)\d+$/.test(token));

        if (firstIsBase && hasVariantSyntax) {
            for (const token of variantTokens) {
                const match = token.match(/^([A-Z][A-Z0-9_-]*)(?:\+|X)(\d+)$/);
                const productCode = resolveVariant(first, match[1], catalog);
                if (!productCode) return result(normalized, [], STATUS.UNKNOWN_PRODUCT, `找不到商品口味：${first}-${match[1]}`, action, first);
                items.push({ productCode, quantity: Number(match[2]) });
            }
            return result(normalized, items, STATUS.READY, "", action, first);
        }

        for (const token of tokens) {
            const item = parseDirectToken(token, catalog);
            if (!item) {
                const unknown = token.match(/^([A-Z][A-Z0-9_-]*)/);
                return result(normalized, items, unknown ? STATUS.UNKNOWN_PRODUCT : STATUS.INCOMPLETE,
                    unknown ? `找不到商品：${unknown[1]}` : `無法解析：${token}`, action);
            }
            if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 999) {
                return result(normalized, items, STATUS.INCOMPLETE, "數量必須介於 1 到 999", action);
            }
            items.push(item);
        }
        return result(normalized, items, STATUS.READY, "", action, items[0]?.productCode.split("-")[0] || "");
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

    return { STATUS, STATUSES, normalizeMessage, parseMessage, isSuspectedDuplicate };
});
