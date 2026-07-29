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

    function enabledProducts(products) {
        return (products || []).filter(product => product && product.enabled);
    }

    function selectedProduct(products, productId) {
        const enabled = enabledProducts(products);
        if (!enabled.length) return null;
        return enabled.find(product => String(product.id) === String(productId || "")) || enabled[0];
    }

    function productOptionLabel(product) {
        if (!product) return "";
        const spec = product.specs ? `（${product.specs}）` : "";
        return `${product.id}｜${product.name}${spec}`;
    }

    function selectedProductImage(products, productId) {
        const product = selectedProduct(products, productId);
        if (!product) return null;
        const url = String(product.photo || product.image_url || "").trim();
        return /^https?:\/\//i.test(url) ? { product, url } : null;
    }

    function generateLineNote(products, options = {}) {
        const title = options.title || "阿賢Easy購｜本檔團購商品";
        const product = selectedProduct(products, options.productId);
        if (!product) return "";
        const divider = "━━━━━━━━━━";
        const section = productLines(product);
        const example = product.id;

        // 團購資訊（截止、到貨、自取／外送說明）
        const info = [];
        if (options.deadline) info.push(`⏰ 收單截止：${options.deadline} 23:59`);
        if (options.arrival) info.push(`🚚 到貨／發貨：${options.arrival}`);
        if (options.pickupInfo) info.push(`🏠 自取／外送：${options.pickupInfo}`);
        if (options.notes) info.push(`📌 ${options.notes}`);

        const howTo = [
            "🖱️ 下單方式：請直接點選群組中的商品訂購卡選擇數量（1份／2份／3份）",
            "　不用在聊天室留言＋1，按鈕下單不會洗版",
            "　要幾份就按幾份，以最後一次按的為準（不會累加）",
            "　按了卡片不會有任何回應是正常的，老闆後台都收得到",
            `📝 超過3份或想留言下單：商品代碼＋數量，例如「${example}+5」`
        ];
        howTo.push("　只有一樣商品，直接留言「+2」也可以");
        howTo.push(`✏️ 更正訂單：「更正 ${example}+3」`, `❌ 取消訂單：「取消 ${example}」或按商品卡「取消訂購」`);

        const blocks = [`🛒 ${title}`, divider, section, divider];
        if (info.length) blocks.push(info.join("\n"), divider);
        blocks.push(howTo.join("\n"));
        return blocks.join("\n");
    }

    return {
        enabledProducts,
        generateLineNote,
        productOptionLabel,
        selectedProduct,
        selectedProductImage
    };
});
