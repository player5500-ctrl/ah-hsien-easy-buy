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
        const description = String(product.description || "").trim();
        if (description) lines.push(`ℹ️ ${description}`);
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

        // 團購資訊（截止、到貨、自取／外送說明）
        const info = [];
        if (options.deadline) info.push(`⏰ 收單截止：${options.deadline} 23:59`);
        if (options.arrival) info.push(`🚚 到貨／發貨：${options.arrival}`);
        if (options.pickupInfo) info.push(`🏠 自取／外送：${options.pickupInfo}`);
        if (options.notes) info.push(`📌 ${options.notes}`);

        const howTo = [
            "🖱️ 下單方式：請直接點選群組中的商品訂購卡選擇數量（1份／2份／3份）",
            "　不用在聊天室留言＋1，按鈕下單不會洗版",
            "📝 也可以在聊天室留言下單",
            `　商品代碼＋數量，例如「${example}+2」`
        ];
        if (enabled.length === 1) howTo.push("　只有一樣商品，直接留言「+2」也可以");
        howTo.push(`✏️ 更正訂單：「更正 ${example}+3」`, `❌ 取消訂單：「取消 ${example}」或按商品卡「取消訂購」`);

        const blocks = [`🛒 ${title}`, divider, sections, divider];
        if (info.length) blocks.push(info.join("\n"), divider);
        blocks.push(howTo.join("\n"));
        return blocks.join("\n");
    }

    return { generateLineNote };
});
