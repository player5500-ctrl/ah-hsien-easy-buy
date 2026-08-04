// 共用的商品欄位驗證／代碼正規化邏輯。
// 抽出成獨立檔案是為了讓 index.js 與 product-groups.js 都能重複使用同一套規則，
// 兩者互不 require 對方（避免循環相依）。行為與抽出前的 index.js 完全一致。

function normalizeLineCode(value) {
    const code = String(value || "").normalize("NFKC").toUpperCase().trim();
    return /^[A-Z][A-Z0-9_-]*$/.test(code) ? code : "";
}

function validateProductPayload(payload) {
    const name = String(payload.name || "").trim();
    if (!name) return { error: "商品名稱必填" };
    const rawCode = payload.line_code == null ? "" : String(payload.line_code).trim();
    const lineCode = rawCode ? normalizeLineCode(rawCode) : null;
    if (rawCode && !lineCode) return { error: "商品代碼格式錯誤，需以英文字母開頭，例如 A001" };
    const price = Number(payload.price ?? 0);
    if (!Number.isInteger(price) || price < 0) return { error: "價格必須是 0 以上的整數" };
    // 雙價：自取價／外送價為選填，缺值存 null（下單時回退 legacy price，見 liff.js effectivePrice）。
    const parseOptionalPrice = (value, label) => {
        if (value == null || value === "") return { value: null };
        const num = Number(value);
        if (!Number.isInteger(num) || num < 0) return { error: `${label}必須是 0 以上的整數` };
        return { value: num };
    };
    const pickup = parseOptionalPrice(payload.pickup_price, "自取價");
    if (pickup.error) return { error: pickup.error };
    const delivery = parseOptionalPrice(payload.delivery_price, "外送價");
    if (delivery.error) return { error: delivery.error };
    return {
        name,
        lineCode,
        price,
        pickupPrice: pickup.value,
        deliveryPrice: delivery.value,
        specs: String(payload.specs || "").trim() || null,
        unit: String(payload.unit || "").trim() || "份",
        description: String(payload.description || "").trim() || null,
        imageUrl: String(payload.image_url || "").trim() || null,
        enabled: payload.enabled === undefined ? 1 : (payload.enabled ? 1 : 0)
    };
}

function isUniqueViolation(error) {
    return /UNIQUE constraint failed/i.test(error?.message || "");
}

module.exports = { normalizeLineCode, validateProductPayload, isUniqueViolation };
