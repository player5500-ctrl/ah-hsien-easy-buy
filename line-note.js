(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.LineNote = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function formatPrice(value) {
        const price = Number(value);
        return Number.isFinite(price) ? `NT$${Math.round(price)}` : "";
    }

    function productLines(product) {
        const spec = product.specs ? `（${product.specs}）` : "";
        const unit = product.unit ? `／${product.unit}` : "";
        const lines = [`【${product.id}】${product.name}${spec}`, `💰 ${formatPrice(product.price)}${unit}`];
        const photo = String(product.photo || product.image_url || "").trim();
        if (/^https?:\/\//i.test(photo)) lines.push(`🖼 ${photo}`);
        return lines.join("\n");
    }

    function generateLineNote(products, options = {}) {
        const title = options.title || "阿賢Easy購｜本檔團購商品";
        const enabled = (products || []).filter(p => p && p.enabled);
        if (!enabled.length) return "";
        const divider = "━━━━━━━━━━";
        const sections = enabled.map(productLines).join("\n\n");
        const example = enabled[0].id;
        const howTo = [
            "📝 下單方式：直接在聊天室留言",
            `　商品代碼＋數量，例如「${example}+2」`
        ];
        if (enabled.length === 1) howTo.push("　只有一樣商品，直接留言「+2」也可以");
        howTo.push(`✏️ 更正訂單：「更正 ${example}+3」`, `❌ 取消訂單：「取消 ${example}」`);
        return [`🛒 ${title}`, divider, sections, divider, howTo.join("\n")].join("\n");
    }

    return { generateLineNote };
});
