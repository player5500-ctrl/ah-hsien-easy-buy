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

    function groupProducts(products, productIds) {
        const available = products || [];
        if (!Array.isArray(productIds) || !productIds.length) return available;
        const selectedIds = new Set(productIds.map(String));
        return available.filter(product => product && selectedIds.has(String(product.id)));
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

    // 0-based index -> A, B, ... Z, AA, AB...（跟 worker/src/product-groups.js 的 letterSuffix 一致）。
    function letterSuffix(index) {
        let n = index + 1;
        let letters = "";
        while (n > 0) {
            n -= 1;
            letters = String.fromCharCode(65 + (n % 26)) + letters;
            n = Math.floor(n / 26);
        }
        return letters;
    }

    function groupVariants(products, productGroupId) {
        const enabled = enabledProducts(products).filter(product =>
            String(product.productGroupId || product.product_group_id || "") === String(productGroupId || ""));
        return enabled.slice().sort((a, b) => {
            const sortA = Number(a.variantSort ?? a.variant_sort ?? 0);
            const sortB = Number(b.variantSort ?? b.variant_sort ?? 0);
            if (sortA !== sortB) return sortA - sortB;
            return String(a.id).localeCompare(String(b.id));
        });
    }

    function formatPriceNumber(value) {
        const price = Number(value);
        return Number.isFinite(price) ? String(Math.round(price)) : "0";
    }

    function variantPrices(product) {
        const base = Number(product.price || 0);
        const pickupRaw = product.pickupPrice ?? product.pickup_price;
        const deliveryRaw = product.deliveryPrice ?? product.delivery_price;
        return {
            pickup: pickupRaw == null || pickupRaw === "" ? base : Number(pickupRaw),
            delivery: deliveryRaw == null || deliveryRaw === "" ? base : Number(deliveryRaw)
        };
    }

    function variantBlock(product, letter) {
        const variantName = String(product.variantName || product.variant_name || product.name || "").trim();
        const spec = String(product.specs || "").trim();
        const prices = variantPrices(product);
        const lines = [`${letter}｜${variantName}`];
        if (spec) lines.push(spec);
        lines.push(`自取${formatPriceNumber(prices.pickup)}元／外送${formatPriceNumber(prices.delivery)}元`);
        return lines.join("\n");
    }

    // 一個商品、多個口味：同一個主商品只產生一篇記事本文案，把每個口味分別列出
    // （價格不同就分別列出各自的自取／外送價），管理者仍需手動貼到 LINE 記事本。
    function generateGroupLineNote(products, options = {}) {
        const groupName = String(options.groupName || options.title || "").trim();
        const variants = groupVariants(products, options.productGroupId);
        if (!groupName || !variants.length) return "";
        const divider = "━━━━━━━━━━";
        const variantBlocks = variants.map((product, index) => variantBlock(product, letterSuffix(index)));

        const info = [];
        if (options.deadline) info.push(`⏰ 收單截止：${options.deadline} 23:59`);
        if (options.arrival) info.push(`🚚 到貨／發貨：${options.arrival}`);
        if (options.pickupInfo) info.push(`🏠 自取／外送：${options.pickupInfo}`);
        if (options.notes) info.push(`📌 ${options.notes}`);

        const howTo = [
            "🖱️ 下單方式：請點選LINE商品卡，再選擇口味及數量",
            "　不用在聊天室留言＋1，按鈕下單不會洗版",
            "　要幾份就按幾份，以最後一次選的為準（不會累加）",
            "　按了卡片不會有任何回應是正常的，老闆後台都收得到",
            "✏️ 更正或取消訂單：進LIFF訂購頁重新選擇口味／數量，或按商品卡「查看／修改我的訂單」"
        ];

        const blocks = [`🛒 ${groupName}開團`, divider, "口味：", variantBlocks.join("\n"), divider];
        if (info.length) blocks.push(info.join("\n"), divider);
        blocks.push(howTo.join("\n"));
        return blocks.join("\n");
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
        generateGroupLineNote,
        groupProducts,
        groupVariants,
        productOptionLabel,
        selectedProduct,
        selectedProductImage
    };
});
