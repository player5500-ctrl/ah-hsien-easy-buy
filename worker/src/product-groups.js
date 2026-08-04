// 「一個商品、多個口味／款式」（product_groups）。
//
// 設計原則（對應需求文件第一～三、十三、十五節）：
//   - 客戶只看到一個主商品（product_groups），系統內部每個口味仍是 products 的獨立商品，
//     各自獨立價格、庫存、訂單與統計；本檔案不建立第二套商品/訂單/庫存系統。
//   - 新建群組時，每個口味的 products.name 會合成為「主商品名稱 口味名稱」（例：德國Pril洗碗精 檸檬），
//     這樣既有的商品搜尋、Excel、列印、LINE記事本、訂單顯示（全部直接讀 products.name／order_items 快照）
//     不用任何修改就能正確顯示口味資訊；products.variant_name 另外保留純口味名稱（例：檨檬）供分組畫面使用。
//   - 「合併既有商品」不會改名、不改 id、不動庫存、不動訂單，只寫入 product_group_id / variant_name / variant_sort。
//   - 商品編號一律由伺服器產生（PG024 / P024-A / P024-B…），不接受前端指定，避免使用者輸入到 SKU/D1 等字眼。
const { validateProductPayload, isUniqueViolation } = require("./product-shared.js");

class ProductGroupHttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "ProductGroupHttpError";
        this.status = status;
        this.code = code;
    }
}

// 0-based index -> A, B, ... Z, AA, AB, ...（與 Excel 欄名相同的雙射進位)
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

// letterSuffix 的反函數，用來找出某主商品目前已用到第幾個口味代號。
function lettersToIndex(letters) {
    let n = 0;
    for (const ch of String(letters || "").toUpperCase()) {
        const code = ch.charCodeAt(0) - 64;
        if (code < 1 || code > 26) return -1;
        n = n * 26 + code;
    }
    return n - 1;
}

function padBase(number) {
    return String(number).padStart(3, "0");
}

function composeVariantName(groupName, variantName) {
    const group = String(groupName || "").trim();
    const variant = String(variantName || "").trim();
    return variant ? `${group} ${variant}`.trim() : group;
}

async function findMaxBaseNumber(env) {
    const [productsResult, groupsResult] = await Promise.all([
        env.DB.prepare("SELECT id FROM products").all(),
        env.DB.prepare("SELECT id FROM product_groups").all()
    ]);
    let max = 0;
    for (const row of productsResult.results) {
        const match = String(row.id || "").match(/^P(\d+)(?:-[A-Z]+)?$/i);
        if (match) max = Math.max(max, Number(match[1]));
    }
    for (const row of groupsResult.results) {
        const match = String(row.id || "").match(/^PG(\d+)$/i);
        if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
}

// 產生一個尚未使用的主商品編號＋N 個口味編號（新增商品用）。variantCount 可為 0（僅要主商品編號，合併既有商品用）。
async function nextGroupCodes(env, variantCount) {
    const base = padBase((await findMaxBaseNumber(env)) + 1);
    return {
        groupId: `PG${base}`,
        variantIds: Array.from({ length: variantCount }, (_unused, index) => `P${base}-${letterSuffix(index)}`)
    };
}

// 幫既有主商品新增一個口味時，找出下一個尚未使用的口味代號（A、B…、AA、AB…）。
async function nextVariantId(env, groupId) {
    const base = String(groupId || "").match(/^PG(\d+)$/i);
    if (!base) throw new ProductGroupHttpError(400, "INVALID_GROUP_ID", "主商品編號格式錯誤");
    const baseNumber = base[1];
    const rows = await env.DB.prepare("SELECT id FROM products WHERE product_group_id = ?").bind(groupId).all();
    const suffixPattern = new RegExp(`^P${baseNumber}-([A-Z]+)$`, "i");
    let maxIndex = -1;
    for (const row of rows.results) {
        const match = String(row.id || "").match(suffixPattern);
        if (match) maxIndex = Math.max(maxIndex, lettersToIndex(match[1]));
    }
    return `P${baseNumber}-${letterSuffix(maxIndex + 1)}`;
}

function isDuplicateRequest(error) {
    return /UNIQUE constraint failed:\s*order_mutation_requests\.request_id/i.test(String(error?.message || ""));
}

function validateGroupMetaPayload(payload) {
    const name = String(payload?.name || "").trim();
    if (!name) return { error: "主商品名稱必填" };
    return {
        name,
        description: String(payload?.description || "").trim() || null,
        imageUrl: String(payload?.image_url || payload?.imageUrl || "").trim() || null,
        enabled: payload?.enabled === undefined ? 1 : (payload.enabled ? 1 : 0)
    };
}

// 口味欄位驗證：沿用既有商品驗證規則（價格／自取價／外送價／規格／單位…），
// 額外要求「口味名稱」必填，並把 products.name 合成為「主商品名稱 口味名稱」。
function validateVariantPayload(payload, groupName) {
    const variantName = String(payload?.variant_name ?? payload?.variantName ?? "").trim();
    if (!variantName) return { error: "口味／款式名稱必填" };
    const base = validateProductPayload({ ...payload, name: composeVariantName(groupName, variantName) });
    if (base.error) return base;
    const rawSort = payload?.variant_sort ?? payload?.variantSort;
    const useGroupImageRaw = payload?.use_group_image ?? payload?.useGroupImage;
    return {
        ...base,
        variantName,
        variantSort: Number.isInteger(Number(rawSort)) ? Number(rawSort) : null,
        useGroupImage: useGroupImageRaw === undefined ? false : Boolean(useGroupImageRaw)
    };
}

async function listProductGroups(env) {
    const groups = await env.DB.prepare("SELECT * FROM product_groups ORDER BY enabled DESC, id").all();
    const variants = await env.DB.prepare("SELECT * FROM products WHERE product_group_id IS NOT NULL ORDER BY product_group_id, variant_sort, id").all();
    const byGroup = new Map();
    for (const variant of variants.results) {
        if (!byGroup.has(variant.product_group_id)) byGroup.set(variant.product_group_id, []);
        byGroup.get(variant.product_group_id).push(variant);
    }
    return groups.results.map(group => ({ ...group, variants: byGroup.get(group.id) || [] }));
}

async function getProductGroup(env, groupId) {
    const group = await env.DB.prepare("SELECT * FROM product_groups WHERE id = ?").bind(groupId).first();
    if (!group) return null;
    const variants = await env.DB.prepare("SELECT * FROM products WHERE product_group_id = ? ORDER BY variant_sort, id").bind(groupId).all();
    return { ...group, variants: variants.results };
}

// 建立主商品＋所有口味（單一 transaction；任一口味失敗全部 rollback；requestId 防重複點擊）。
async function createProductGroupWithVariants(env, payload) {
    const requestId = String(payload?.request_id ?? payload?.requestId ?? "").trim();
    if (!requestId) return { error: "缺少 requestId，請重新整理頁面再試一次", status: 400 };
    const meta = validateGroupMetaPayload(payload);
    if (meta.error) return { error: meta.error, status: 400 };
    const variantsInput = Array.isArray(payload?.variants) ? payload.variants : [];
    if (!variantsInput.length) return { error: "至少需要一個口味／款式", status: 400 };
    if (variantsInput.length > 50) return { error: "口味／款式數量過多（上限 50）", status: 400 };

    const variants = [];
    for (const raw of variantsInput) {
        const variant = validateVariantPayload(raw, meta.name);
        if (variant.error) return { error: variant.error, status: 400 };
        variants.push(variant);
    }
    const lowerNames = variants.map(variant => variant.variantName.toLowerCase());
    if (new Set(lowerNames).size !== lowerNames.length) {
        return { error: "同一個主商品內的口味名稱不可重複", status: 400 };
    }

    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const codes = await nextGroupCodes(env, variants.length);
        const statements = [
            env.DB.prepare("INSERT INTO order_mutation_requests (request_id, source_type) VALUES (?, 'product_group_create')").bind(requestId),
            env.DB.prepare(`INSERT INTO product_groups (id, name, description, image_url, enabled, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
                .bind(codes.groupId, meta.name, meta.description, meta.imageUrl, meta.enabled)
        ];
        variants.forEach((variant, index) => {
            const variantId = codes.variantIds[index];
            statements.push(env.DB.prepare(`INSERT INTO products
                (id, name, enabled, line_code, price, pickup_price, delivery_price, specs, unit, description, image_url, updated_at,
                 product_group_id, variant_name, variant_sort, use_group_image)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)`)
                .bind(variantId, variant.name, variant.enabled, variant.lineCode || variantId, variant.price,
                    variant.pickupPrice, variant.deliveryPrice, variant.specs, variant.unit, variant.description,
                    variant.imageUrl, codes.groupId, variant.variantName, index, variant.useGroupImage ? 1 : 0));
        });
        try {
            await env.DB.batch(statements);
            return { data: { id: codes.groupId, variantIds: codes.variantIds, created: true } };
        } catch (error) {
            if (isDuplicateRequest(error)) return { data: { duplicate: true } };
            if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS - 1) continue;
            throw error;
        }
    }
    return { error: "商品編號產生失敗，請再試一次", status: 500 };
}

// 幫既有主商品新增一個口味（商品管理列表的「新增口味」按鈕）。
async function addVariantToGroup(env, groupId, payload) {
    const requestId = String(payload?.request_id ?? payload?.requestId ?? "").trim();
    if (!requestId) return { error: "缺少 requestId，請重新整理頁面再試一次", status: 400 };
    const group = await env.DB.prepare("SELECT * FROM product_groups WHERE id = ?").bind(groupId).first();
    if (!group) return { error: "找不到主商品", status: 404 };
    const variant = validateVariantPayload(payload, group.name);
    if (variant.error) return { error: variant.error, status: 400 };
    const existing = await env.DB.prepare("SELECT variant_name, variant_sort FROM products WHERE product_group_id = ?").bind(groupId).all();
    if (existing.results.some(row => String(row.variant_name || "").toLowerCase() === variant.variantName.toLowerCase())) {
        return { error: "此主商品已有相同口味名稱", status: 409 };
    }
    const nextSort = existing.results.reduce((max, row) => Math.max(max, Number(row.variant_sort || 0)), -1) + 1;

    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const variantId = await nextVariantId(env, groupId);
        try {
            await env.DB.batch([
                env.DB.prepare("INSERT INTO order_mutation_requests (request_id, source_type) VALUES (?, 'product_group_variant_add')").bind(requestId),
                env.DB.prepare(`INSERT INTO products
                    (id, name, enabled, line_code, price, pickup_price, delivery_price, specs, unit, description, image_url, updated_at,
                     product_group_id, variant_name, variant_sort, use_group_image)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)`)
                    .bind(variantId, variant.name, variant.enabled, variant.lineCode || variantId, variant.price,
                        variant.pickupPrice, variant.deliveryPrice, variant.specs, variant.unit, variant.description,
                        variant.imageUrl, groupId, variant.variantName, nextSort, variant.useGroupImage ? 1 : 0)
            ]);
            return { data: { id: variantId, created: true } };
        } catch (error) {
            if (isDuplicateRequest(error)) return { data: { duplicate: true } };
            if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS - 1) continue;
            throw error;
        }
    }
    return { error: "商品編號產生失敗，請再試一次", status: 500 };
}

// 更新單一口味（商品編號固定不可變更，只能改內容；有訂單參照的編號本函式本來就不會去動 id）。
async function updateVariant(env, groupId, productId, payload) {
    const group = await env.DB.prepare("SELECT * FROM product_groups WHERE id = ?").bind(groupId).first();
    if (!group) return { error: "找不到主商品", status: 404 };
    const existing = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(productId).first();
    if (!existing || existing.product_group_id !== groupId) return { error: "找不到此主商品下的口味", status: 404 };
    const variant = validateVariantPayload(payload, group.name);
    if (variant.error) return { error: variant.error, status: 400 };
    const sort = variant.variantSort == null ? existing.variant_sort : variant.variantSort;
    try {
        const result = await env.DB.prepare(`UPDATE products SET name = ?, enabled = ?, line_code = ?, price = ?, pickup_price = ?,
                delivery_price = ?, specs = ?, unit = ?, description = ?, image_url = ?, variant_name = ?, variant_sort = ?,
                use_group_image = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND product_group_id = ?`)
            .bind(variant.name, variant.enabled, variant.lineCode || productId, variant.price, variant.pickupPrice,
                variant.deliveryPrice, variant.specs, variant.unit, variant.description, variant.imageUrl,
                variant.variantName, sort, variant.useGroupImage ? 1 : 0, productId, groupId).run();
        if (!result.meta.changes) return { error: "找不到此主商品下的口味", status: 404 };
        return { data: { id: productId, updated: true } };
    } catch (error) {
        if (isUniqueViolation(error)) return { error: `商品代碼 ${variant.lineCode || productId} 已存在`, status: 409 };
        throw error;
    }
}

// 更新主商品本身的名稱／介紹／圖片／啟用狀態。停用整組時一併停止所有口味的新訂購（保留訂單／庫存紀錄）。
async function updateProductGroup(env, groupId, payload) {
    const meta = validateGroupMetaPayload(payload);
    if (meta.error) return { error: meta.error, status: 400 };
    const existing = await env.DB.prepare("SELECT * FROM product_groups WHERE id = ?").bind(groupId).first();
    if (!existing) return { error: "找不到主商品", status: 404 };
    const statements = [
        env.DB.prepare("UPDATE product_groups SET name = ?, description = ?, image_url = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(meta.name, meta.description, meta.imageUrl, meta.enabled, groupId)
    ];
    if (existing.enabled && !meta.enabled) {
        statements.push(env.DB.prepare("UPDATE products SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE product_group_id = ?").bind(groupId));
    }
    await env.DB.batch(statements);
    return { data: { id: groupId, updated: true } };
}

// 刪除主商品群組：任一口味有訂單或庫存異動紀錄就整組不可刪除（改用停用），避免孤兒資料與破壞稽核紀錄。
async function deleteProductGroup(env, groupId) {
    const variants = await env.DB.prepare("SELECT id FROM products WHERE product_group_id = ?").bind(groupId).all();
    if (!variants.results.length) {
        const result = await env.DB.prepare("DELETE FROM product_groups WHERE id = ?").bind(groupId).run();
        if (!result.meta.changes) return { error: "找不到主商品", status: 404 };
        return { data: { id: groupId, deleted: true } };
    }
    for (const variant of variants.results) {
        const ordered = await env.DB.prepare("SELECT 1 FROM order_items WHERE product_id = ? OR product_code = ? LIMIT 1").bind(variant.id, variant.id).first();
        if (ordered) return { error: `口味 ${variant.id} 已有訂單紀錄，不可刪除整組，請改用停用`, status: 409 };
        const moved = await env.DB.prepare("SELECT 1 FROM inventory_movements WHERE product_id = ? LIMIT 1").bind(variant.id).first();
        if (moved) return { error: `口味 ${variant.id} 已有庫存異動紀錄，不可刪除整組，請改用停用`, status: 409 };
    }
    const statements = [];
    for (const variant of variants.results) {
        statements.push(env.DB.prepare("DELETE FROM group_buy_products WHERE product_id = ?").bind(variant.id));
        statements.push(env.DB.prepare("DELETE FROM products WHERE id = ?").bind(variant.id));
    }
    statements.push(env.DB.prepare("DELETE FROM product_groups WHERE id = ?").bind(groupId));
    await env.DB.batch(statements);
    return { data: { id: groupId, deleted: true, removedVariantIds: variants.results.map(variant => variant.id) } };
}

// 合併既有商品成一組（只預覽，不寫入）。
async function previewMerge(env, payload) {
    const productIds = Array.isArray(payload?.product_ids)
        ? [...new Set(payload.product_ids.map(id => String(id).trim()).filter(Boolean))]
        : [];
    if (productIds.length < 2) return { error: "請選擇至少兩個既有商品進行合併", status: 400 };
    const name = String(payload?.name || "").trim();
    if (!name) return { error: "主商品名稱必填", status: 400 };
    const placeholders = productIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).bind(...productIds).all();
    if (rows.results.length !== productIds.length) return { error: "有商品編號不存在，請重新確認", status: 400 };
    const alreadyGrouped = rows.results.filter(row => row.product_group_id);
    if (alreadyGrouped.length) {
        return { error: `商品 ${alreadyGrouped.map(row => row.id).join("、")} 已經屬於其他主商品群組`, status: 409 };
    }
    const variantNames = payload?.variant_names || payload?.variantNames || {};
    const variants = productIds.map((id, index) => {
        const row = rows.results.find(candidate => candidate.id === id);
        const variantName = String(variantNames[id] || row.variant_name || "").trim() || row.name;
        return { productId: id, currentName: row.name, currentSpecs: row.specs, variantName, sort: index };
    });
    const lowerNames = variants.map(variant => variant.variantName.toLowerCase());
    if (new Set(lowerNames).size !== lowerNames.length) return { error: "口味名稱不可重複", status: 400 };
    return { data: { preview: true, groupName: name, variants } };
}

// 合併既有商品成一組（實際寫入）：只建立 product_groups、寫入 product_group_id／口味名稱／顯示順序，
// 絕不修改 productId、刪除原商品、改變訂單參照、重算或重扣庫存。
async function applyMerge(env, payload) {
    const requestId = String(payload?.request_id ?? payload?.requestId ?? "").trim();
    if (!requestId) return { error: "缺少 requestId，請重新整理頁面再試一次", status: 400 };
    const previewResult = await previewMerge(env, payload);
    if (previewResult.error) return previewResult;
    const { groupName, variants } = previewResult.data;
    const description = String(payload?.description || "").trim() || null;
    const imageUrl = String(payload?.image_url ?? payload?.imageUrl ?? "").trim() || null;

    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const codes = await nextGroupCodes(env, 0);
        const statements = [
            env.DB.prepare("INSERT INTO order_mutation_requests (request_id, source_type) VALUES (?, 'product_group_merge')").bind(requestId),
            env.DB.prepare("INSERT INTO product_groups (id, name, description, image_url, enabled, updated_at) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)")
                .bind(codes.groupId, groupName, description, imageUrl)
        ];
        variants.forEach(variant => {
            statements.push(env.DB.prepare(`UPDATE products SET product_group_id = ?, variant_name = ?, variant_sort = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND product_group_id IS NULL`)
                .bind(codes.groupId, variant.variantName, variant.sort, variant.productId));
        });
        try {
            await env.DB.batch(statements);
            return { data: { id: codes.groupId, merged: true, variantIds: variants.map(variant => variant.productId) } };
        } catch (error) {
            if (isDuplicateRequest(error)) return { data: { duplicate: true } };
            if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS - 1) continue;
            throw error;
        }
    }
    return { error: "商品編號產生失敗，請再試一次", status: 500 };
}

// 依口味的庫存狀態，計算主商品整體狀態：open（開放訂購）／partial_sold_out（部分口味售完）／all_sold_out（全部售完）。
// stocks 為 Inventory.publicStock() 回傳的陣列（可能含 null）。沒有任何口味限量庫存時視為開放訂購。
function summarizeGroupStock(stocks) {
    const list = (stocks || []).filter(Boolean);
    const limited = list.filter(stock => stock.stockEnabled);
    if (!limited.length) return "open";
    const soldOutCount = limited.filter(stock => stock.stockStatus === "sold_out").length;
    if (soldOutCount === 0) return "open";
    if (soldOutCount === limited.length) return "all_sold_out";
    return "partial_sold_out";
}

module.exports = {
    ProductGroupHttpError,
    letterSuffix,
    lettersToIndex,
    nextGroupCodes,
    nextVariantId,
    composeVariantName,
    validateGroupMetaPayload,
    validateVariantPayload,
    listProductGroups,
    getProductGroup,
    createProductGroupWithVariants,
    addVariantToGroup,
    updateVariant,
    updateProductGroup,
    deleteProductGroup,
    previewMerge,
    applyMerge,
    summarizeGroupStock
};
