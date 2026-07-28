function normalizeQuantities(values) {
    const input = Array.isArray(values) ? values : [1, 2, 3];
    return [...new Set(input.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 99))].slice(0, 3);
}

function createPostbackData(action, groupBuyId, productId, quantity) {
    const params = new URLSearchParams({ action, groupBuyId, productId });
    if (quantity !== undefined) params.set("quantity", String(quantity));
    return params.toString();
}

function parsePostbackData(data) {
    const params = new URLSearchParams(String(data || ""));
    const action = params.get("action") || "";
    const groupBuyId = (params.get("groupBuyId") || "").trim();
    const productId = (params.get("productId") || "").trim();
    if (params.has("price")) return { error: "Postback 不可包含價格" };
    if (!groupBuyId || !productId) return { error: "缺少團購或商品識別碼" };
    if (!new Set(["set_quantity", "cancel_item", "view_order"]).has(action)) return { error: "不支援的 Postback action" };
    if (action === "set_quantity") {
        const quantity = Number(params.get("quantity"));
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return { error: "數量格式錯誤" };
        return { action, groupBuyId, productId, quantity };
    }
    return { action, groupBuyId, productId, quantity: action === "cancel_item" ? 0 : undefined };
}

function deadlineLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "未設定");
    return new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).format(date);
}

// LIFF 深連結：開啟客戶端下單頁。URI 內只放團購/商品/數量/動作，
// 絕不放價格、userId 或 token（見 TASK 規範）。無 displayText，群組保持靜默。
function liffOrderUri(liffId, { groupBuyId, productId, quantity, action } = {}) {
    const qs = new URLSearchParams();
    if (groupBuyId != null && groupBuyId !== "") qs.set("groupBuyId", String(groupBuyId));
    if (productId != null && productId !== "") qs.set("productId", String(productId));
    if (quantity != null && quantity !== "") qs.set("quantity", String(quantity));
    if (action != null && action !== "") qs.set("action", String(action));
    const query = qs.toString();
    return `https://liff.line.me/${liffId}${query ? `?${query}` : ""}`;
}

function buildFlexMessage({ groupBuy, product, showImage = true, quantities = [1, 2, 3], liffId = null }) {
    const buttons = normalizeQuantities(quantities);
    if (!buttons.length) throw new Error("至少選擇一個數量按鈕");
    // 有設定 LIFF_ID → 按鈕改開 LIFF 下單頁（URI action，靜默、可確認、可改量取消）。
    // 缺 LIFF_ID → 回退既有 Postback 按鈕，維持設定前的行為不中斷。
    const useLiff = typeof liffId === "string" && liffId.trim() !== "";
    const gid = String(groupBuy.id);
    const pid = String(product.id);

    const quantityButtonsBox = {
        type: "box", layout: "horizontal", spacing: "sm", margin: "xl",
        contents: buttons.map(quantity => ({
            type: "button", height: "sm", style: "primary", color: "#E86A33",
            action: useLiff
                ? { type: "uri", label: `${quantity}份`, uri: liffOrderUri(liffId, { groupBuyId: gid, productId: pid, quantity }) }
                : { type: "postback", label: `${quantity}份`, data: createPostbackData("set_quantity", gid, pid, quantity) }
        }))
    };

    const bodyContents = [
        { type: "text", text: String(product.name), weight: "bold", size: "xl", wrap: true },
        { type: "text", text: String(product.specs || "無規格"), size: "sm", color: "#666666", wrap: true, margin: "sm" },
        ...(product.stock_enabled ? [{
            type: "text",
            text: `限量 ${Number(product.sellable_quantity || 0)} ${product.unit || "份"}｜售完為止`,
            size: "sm",
            color: "#C0392B",
            weight: "bold",
            wrap: true,
            margin: "sm"
        }] : []),
        {
            type: "box", layout: "baseline", margin: "lg", contents: [
                { type: "text", text: `NT$ ${Number(product.price).toLocaleString("zh-TW")}`, weight: "bold", size: "xl", color: "#E86A33", flex: 0 },
                { type: "text", text: `/ ${product.unit || "份"}`, size: "sm", color: "#777777", margin: "sm", flex: 0 }
            ]
        },
        { type: "separator", margin: "lg" },
        { type: "text", text: `團購：${groupBuy.name}`, size: "sm", wrap: true, margin: "lg" },
        { type: "text", text: `收單截止：${deadlineLabel(groupBuy.ends_at)}`, size: "sm", color: "#C0392B", wrap: true, margin: "sm" },
        quantityButtonsBox
    ];

    if (useLiff) {
        // 立即訂購（quantity=1）→ 開 LIFF 下單頁；查看／修改我的訂單、取消訂購 → LIFF myorder 頁確認。
        bodyContents.push({
            type: "button", height: "sm", style: "primary", color: "#E86A33", margin: "md",
            action: { type: "uri", label: "立即訂購", uri: liffOrderUri(liffId, { groupBuyId: gid, productId: pid, quantity: 1 }) }
        });
        bodyContents.push({
            type: "button", height: "sm", style: "secondary", margin: "md",
            action: { type: "uri", label: "查看／修改我的訂單", uri: liffOrderUri(liffId, { groupBuyId: gid, action: "myorder" }) }
        });
        bodyContents.push({
            type: "button", height: "sm", style: "secondary", margin: "md",
            action: { type: "uri", label: "取消訂購", uri: liffOrderUri(liffId, { groupBuyId: gid, productId: pid, action: "myorder" }) }
        });
    } else {
        // 回退：維持既有 Postback 取消訂購按鈕。「查看我的訂單」（view_order）仍不重建，
        // 沿用 2026-07-22 決議；parsePostbackData 仍接受舊卡片的 view_order。
        bodyContents.push({
            type: "button", height: "sm", style: "secondary", margin: "md",
            action: { type: "postback", label: "取消訂購", data: createPostbackData("cancel_item", gid, pid) }
        });
    }

    bodyContents.push({ type: "text", text: "按鈕下單不會在聊天室產生訊息", size: "xs", color: "#888888", align: "center", wrap: true, margin: "md" });
    const bubble = { type: "bubble", body: { type: "box", layout: "vertical", contents: bodyContents } };
    if (showImage && /^https:\/\//i.test(product.image_url || "")) {
        bubble.hero = { type: "image", url: product.image_url, size: "full", aspectRatio: "20:13", aspectMode: "cover" };
    }
    return {
        type: "flex",
        altText: `${product.name}｜${groupBuy.name}（按鈕靜默下單）`.slice(0, 400),
        contents: bubble
    };
}

module.exports = { normalizeQuantities, createPostbackData, parsePostbackData, buildFlexMessage, deadlineLabel, liffOrderUri };
