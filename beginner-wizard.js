(function (root, factory) {
    const api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.BeginnerWizard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    const STORAGE_KEY = "easygo_beginner_wizard";
    const STEP_COUNT = 5;
    const files = new Map();
    const previews = new Map();
    let draft = null;
    let busy = false;

    function today() {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 10);
    }

    function key() {
        return root.crypto && root.crypto.randomUUID
            ? root.crypto.randomUUID()
            : "wizard-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    }

    function blankProduct() {
        return {
            key: key(), productId: "", name: "", specs: "", pickupPrice: "",
            deliveryPrice: "", unit: "", description: "", photo: "", fileName: ""
        };
    }

    function createDraft() {
        return {
            version: 1, step: 1, completed: false,
            // 一個商品、多個口味：isGrouped=true 時，productDrafts 每一項是「口味」，
            // groupMeta 是共用的主商品名稱／說明／圖片，groupId 是伺服器建立後回傳的主商品編號（PG開頭）。
            isGrouped: false, groupMeta: { name: "", description: "", photo: "" }, groupId: "",
            productDrafts: [blankProduct()], productIds: [],
            groupBuyId: "", group: { name: "", endDate: "", notes: "" },
            stockSettings: {}, selectedProductId: "",
            copiedProductIds: [], linePostedProductIds: [],
            selectedLineGroupId: "", publishedProductIds: [], publicationIds: {},
            lastUpdated: new Date().toISOString()
        };
    }

    function nextCode(prefix, ids, width) {
        let max = 0;
        (ids || []).forEach(function (id) {
            const match = String(id || "").match(new RegExp("^" + prefix + "(\\d+)$", "i"));
            if (match) max = Math.max(max, Number(match[1]));
        });
        return prefix + String(max + 1).padStart(width || 3, "0");
    }

    function calculateSellable(incoming, reserved) {
        return Math.max(0, Math.max(0, Number(incoming) || 0) - Math.max(0, Number(reserved) || 0));
    }

    function validateProductDraft(product) {
        const errors = {};
        if (!String(product.name || "").trim()) errors.name = "商品名稱還沒填寫";
        if (String(product.pickupPrice == null ? "" : product.pickupPrice).trim() === "" || Number(product.pickupPrice) < 0) errors.pickupPrice = "請填寫正確的自取價";
        if (String(product.deliveryPrice == null ? "" : product.deliveryPrice).trim() === "" || Number(product.deliveryPrice) < 0) errors.deliveryPrice = "請填寫正確的外送價";
        if (!String(product.unit || "").trim()) errors.unit = "商品單位還沒填寫";
        if (!product.photo && !product.hasFile) errors.photo = "請先選擇商品圖片";
        return errors;
    }

    function validateGroupDraft(group, currentDate) {
        const errors = {};
        if (!String(group.name || "").trim()) errors.name = "團購名稱還沒填寫";
        if (!group.endDate) errors.endDate = "請選擇截止日期";
        else if (group.endDate < (currentDate || today())) errors.endDate = "截止日期不能早於今天";
        return errors;
    }

    function friendlyError(result, fallback) {
        if (!result) return fallback || "儲存失敗，請稍後再試一次";
        if (result.skipped || result.status === 401 || result.status === 403) return "尚未完成系統連線，請先前往設定。";
        if (result.status === 409) return "資料剛剛有變動，請重新確認後再試一次。";
        return fallback || "儲存失敗，請稍後再試一次";
    }

    function needsRepublishConfirmation(publishedIds, productId) {
        return (publishedIds || []).map(String).includes(String(productId));
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char];
        });
    }

    function app() {
        return root.EasyGoApp;
    }

    function state() {
        return app().getState();
    }

    function element(id) {
        return root.document && root.document.getElementById(id);
    }

    function loadDraft() {
        try {
            const raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
            return raw ? Object.assign(createDraft(), JSON.parse(raw)) : null;
        } catch (_error) {
            return null;
        }
    }

    function saveDraft() {
        if (!draft || !root.localStorage) return;
        draft.lastUpdated = new Date().toISOString();
        root.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    }

    function clearDraft() {
        if (root.localStorage) root.localStorage.removeItem(STORAGE_KEY);
    }

    function showPanel(id) {
        ["wizard-connection-panel", "wizard-resume-panel", "wizard-main-panel", "wizard-summary-panel"].forEach(function (panelId) {
            const panel = element(panelId);
            if (panel) panel.hidden = panelId !== id;
        });
    }

    function message(text, type) {
        const target = element("wizard-message");
        if (!target) return;
        target.textContent = text || "";
        target.className = "wizard-message" + (text ? " wizard-message-" + (type || "success") : "");
        target.hidden = !text;
    }

    function fieldError(scope, field, text) {
        const error = scope && scope.querySelector('[data-error="' + field + '"]');
        const input = scope && scope.querySelector('[data-field="' + field + '"]');
        if (error) {
            error.textContent = text || "";
            error.hidden = !text;
        }
        if (input) input.classList.toggle("wizard-invalid", Boolean(text));
    }

    function clearErrors(scope) {
        if (!scope) return;
        scope.querySelectorAll(".wizard-field-error").forEach(function (error) {
            error.textContent = "";
            error.hidden = true;
        });
        scope.querySelectorAll(".wizard-invalid").forEach(function (input) {
            input.classList.remove("wizard-invalid");
        });
    }

    function open() {
        const modal = element("beginner-wizard-modal");
        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");
        root.document.body.classList.add("wizard-open");
        if (!app().hasConnection()) {
            showPanel("wizard-connection-panel");
            return;
        }
        const saved = loadDraft();
        if (saved && !saved.completed) {
            draft = saved;
            showPanel("wizard-resume-panel");
        } else if (saved && saved.completed) {
            draft = saved;
            showSummary();
        } else {
            startFresh();
        }
    }

    function close() {
        rememberStep();
        const modal = element("beginner-wizard-modal");
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
        root.document.body.classList.remove("wizard-open");
    }

    function goToSettings() {
        close();
        app().switchView("line-settings");
    }

    function resume() {
        draft = loadDraft() || createDraft();
        renderStep(draft.step || 1);
    }

    function startFresh() {
        clearDraft();
        files.clear();
        previews.forEach(function (url) { root.URL.revokeObjectURL(url); });
        previews.clear();
        draft = createDraft();
        saveDraft();
        renderStep(1);
    }

    function renderProgress(step) {
        root.document.querySelectorAll(".wizard-progress-item").forEach(function (item) {
            const number = Number(item.dataset.step);
            item.classList.toggle("active", number === step);
            item.classList.toggle("done", number < step || draft.completed);
            item.setAttribute("aria-current", number === step ? "step" : "false");
        });
    }

    function updateFooter() {
        const previous = element("wizard-previous");
        const next = element("wizard-next");
        previous.hidden = draft.step === 1;
        next.textContent = draft.step === 5 ? "完成開團" : "儲存並繼續";
        next.disabled = busy || (draft.step === 4 && !allLinePosted());
    }

    function renderStep(step) {
        draft.step = Math.max(1, Math.min(STEP_COUNT, Number(step) || 1));
        saveDraft();
        showPanel("wizard-main-panel");
        renderProgress(draft.step);
        message("");
        if (draft.step === 1) renderProducts();
        if (draft.step === 2) renderGroup();
        if (draft.step === 3) renderStock();
        if (draft.step === 4) renderLineNote();
        if (draft.step === 5) renderPublish();
        updateFooter();
        const scroll = element("wizard-scroll-area");
        if (scroll) scroll.scrollTop = 0;
    }

    function productCard(product, index) {
        const preview = previews.get(product.key) || product.photo || "";
        const grouped = Boolean(draft.isGrouped);
        return '<article class="wizard-product-card" data-product-key="' + escapeHtml(product.key) + '">' +
            '<div class="wizard-product-heading"><strong>' + (grouped ? "口味 " + (index + 1) : "商品 " + (index + 1)) + '</strong>' +
            (index ? '<button type="button" class="wizard-text-button" onclick="BeginnerWizard.removeFlavor(\'' + escapeHtml(product.key) + '\')">移除此口味</button>' : "") + '</div>' +
            (grouped ? formField("口味／款式名稱", "name", product.name, "例如：檨檬") : formField("商品名稱", "name", product.name, "例如：Pril 洗碗精")) +
            formField("規格", "specs", product.specs, "例如：653ml×3瓶") +
            '<div class="wizard-price-grid">' +
            formField("自取價", "pickupPrice", product.pickupPrice, "", "number") +
            formField("外送價", "deliveryPrice", product.deliveryPrice, "", "number") + '</div>' +
            formField("單位", "unit", product.unit, "例如：組、盒、包") +
            '<div class="wizard-form-group"><label>商品圖片</label>' +
            '<label class="wizard-image-picker"><input type="file" data-field="photo" accept="image/jpeg,image/png,image/webp,image/gif" onchange="BeginnerWizard.previewImage(event,\'' + escapeHtml(product.key) + '\')"><i class="fa-solid fa-image"></i><span>' +
            escapeHtml(product.fileName || "點這裡選擇商品圖片") + '</span></label>' +
            '<small class="wizard-field-error" data-error="photo" hidden></small>' +
            (preview ? '<img class="wizard-image-preview" src="' + escapeHtml(preview) + '" alt="商品圖片預覽">' : "") + '</div>' +
            '<div class="wizard-form-group"><label>商品介紹</label><textarea class="form-control" data-field="description" rows="3" placeholder="簡單介紹特色、保存方式或到貨資訊">' +
            escapeHtml(product.description) + '</textarea><small class="wizard-field-error" data-error="description" hidden></small></div></article>';
    }

    function formField(label, field, value, placeholder, type) {
        return '<div class="wizard-form-group"><label>' + label + '</label><input class="form-control" type="' + (type || "text") +
            '" min="0" inputmode="' + (type === "number" ? "numeric" : "text") + '" data-field="' + field + '" value="' +
            escapeHtml(value) + '" placeholder="' + escapeHtml(placeholder || "") + '"><small class="wizard-field-error" data-error="' +
            field + '" hidden></small></div>';
    }

    // 是否有不同口味／款式：一律用「純文字白話」問法，不出現 product_group_id／variant／SKU／D1／API 等字眼。
    function groupChoiceHtml() {
        const grouped = Boolean(draft.isGrouped);
        return '<div class="wizard-form-group wizard-grouped-choice"><label>這個商品有不同口味／款式嗎？</label>' +
            '<div class="wizard-choice-buttons">' +
            '<label class="wizard-choice-option"><input type="radio" name="wizard-grouped" value="no" ' + (grouped ? "" : "checked") +
            ' onchange="BeginnerWizard.setGrouped(false)"> 沒有，是單一商品</label>' +
            '<label class="wizard-choice-option"><input type="radio" name="wizard-grouped" value="yes" ' + (grouped ? "checked" : "") +
            ' onchange="BeginnerWizard.setGrouped(true)"> 有，同一個商品有不同口味／款式（客戶只會看到一個商品，選好口味再下單）</label>' +
            '</div></div>';
    }

    function groupMetaHtml() {
        if (!draft.isGrouped) return "";
        return '<div id="wizard-group-meta" class="wizard-group-meta-card">' +
            formField("主商品名稱", "groupName", draft.groupMeta.name, "例如：德國 Pril 洗碗精") +
            '<div class="wizard-form-group"><label>主商品說明（選填）</label><textarea class="form-control" data-field="groupDescription" rows="2" placeholder="所有口味共用的介紹文字">' +
            escapeHtml(draft.groupMeta.description) + '</textarea></div></div>';
    }

    function setGrouped(isGrouped) {
        rememberProducts();
        draft.isGrouped = Boolean(isGrouped);
        // 切換模式時保留使用者已輸入的口味卡內容，只是重新解讀「商品名稱」欄位的意義（單一商品名稱 vs 口味名稱）
        saveDraft();
        renderProducts();
    }

    function renderProducts() {
        element("wizard-step-content").innerHTML =
            '<div class="wizard-step-copy"><span>第一步</span><h2>先把商品資料放進來</h2><p>請填寫這次要賣的商品，填好後按下一步。</p></div>' +
            groupChoiceHtml() + groupMetaHtml() +
            '<div id="wizard-products">' + draft.productDrafts.map(productCard).join("") + '</div>' +
            '<button type="button" class="btn btn-secondary wizard-full-button" onclick="BeginnerWizard.addFlavor()"><i class="fa-solid fa-plus"></i> 再新增一個' + (draft.isGrouped ? "口味" : "商品") + '</button>';
    }

    function rememberProducts() {
        const metaScope = element("wizard-group-meta");
        if (metaScope) {
            draft.groupMeta.name = (metaScope.querySelector('[data-field="groupName"]') || {}).value || draft.groupMeta.name;
            draft.groupMeta.description = (metaScope.querySelector('[data-field="groupDescription"]') || {}).value || "";
        }
        root.document.querySelectorAll(".wizard-product-card").forEach(function (card) {
            const product = draft.productDrafts.find(function (item) { return item.key === card.dataset.productKey; });
            if (!product) return;
            card.querySelectorAll("[data-field]:not([type=file])").forEach(function (input) {
                product[input.dataset.field] = input.value;
            });
        });
        saveDraft();
    }

    function addFlavor() {
        rememberProducts();
        draft.productDrafts.push(blankProduct());
        saveDraft();
        renderProducts();
    }

    function removeFlavor(productKey) {
        rememberProducts();
        const product = draft.productDrafts.find(function (item) { return item.key === productKey; });
        if (product && product.productId && state().products.some(function (item) { return item.id === product.productId; })) {
            message("這項商品已經儲存，為避免刪除正式資料，請到商品管理調整。", "error");
            return;
        }
        draft.productDrafts = draft.productDrafts.filter(function (item) { return item.key !== productKey; });
        files.delete(productKey);
        saveDraft();
        renderProducts();
    }

    function previewImage(event, productKey) {
        rememberProducts();
        const file = event.target.files && event.target.files[0];
        const product = draft.productDrafts.find(function (item) { return item.key === productKey; });
        if (!file || !product) return;
        if (previews.has(productKey)) root.URL.revokeObjectURL(previews.get(productKey));
        files.set(productKey, file);
        previews.set(productKey, root.URL.createObjectURL(file));
        product.fileName = file.name;
        product.hasFile = true;
        saveDraft();
        renderProducts();
    }

    async function saveProducts() {
        rememberProducts();
        let valid = true;
        if (draft.isGrouped && !String(draft.groupMeta.name || "").trim()) {
            message("請先填寫主商品名稱。", "error");
            const metaScope = element("wizard-group-meta");
            if (metaScope) fieldError(metaScope, "groupName", "主商品名稱還沒填寫");
            valid = false;
        }
        root.document.querySelectorAll(".wizard-product-card").forEach(function (card) {
            clearErrors(card);
            const product = draft.productDrafts.find(function (item) { return item.key === card.dataset.productKey; });
            product.hasFile = files.has(product.key) || Boolean(product.photo);
            const errors = validateProductDraft(product);
            Object.keys(errors).forEach(function (field) { fieldError(card, field, errors[field]); });
            if (Object.keys(errors).length) valid = false;
        });
        if (!valid) {
            message("請先完成上方標示的商品資料。", "error");
            return false;
        }
        if (draft.isGrouped) return saveProductGroup();

        const assigned = new Set(state().products.map(function (product) { return product.id; }));
        draft.productDrafts.forEach(function (product) {
            if (!product.productId) {
                product.productId = nextCode("P", Array.from(assigned));
                assigned.add(product.productId);
            }
        });
        draft.productIds = draft.productDrafts.map(function (product) { return product.productId; });
        saveDraft();
        for (const item of draft.productDrafts) {
            const product = {
                id: item.productId, name: item.name.trim(), specs: item.specs.trim(),
                price: Math.round(Number(item.pickupPrice)), pickupPrice: Math.round(Number(item.pickupPrice)),
                deliveryPrice: Math.round(Number(item.deliveryPrice)), unit: item.unit.trim(),
                enabled: true, description: item.description.trim(), photo: item.photo || ""
            };
            app().upsertLocalProduct(product);
            const synced = await app().syncProduct(product);
            if (synced.error || synced.skipped) throw new Error(friendlyError(synced, "商品儲存失敗，請稍後再試一次"));
            const file = files.get(item.key);
            if (file && !item.photo) {
                const uploaded = await app().uploadProductImage(product.id, file);
                if (uploaded.error || uploaded.skipped || !uploaded.data || !uploaded.data.image_url) {
                    throw new Error(friendlyError(uploaded, "商品圖片上傳失敗，請重新選擇後再試一次"));
                }
                item.photo = uploaded.data.image_url;
                product.photo = item.photo;
                app().upsertLocalProduct(product);
                saveDraft();
            }
        }
        message("商品已經儲存好了");
        return true;
    }

    // 一個商品、多個口味：建立主商品＋所有口味（單一 API、伺服器產生編號），
    // 已建立過（draft.groupId 已存在）時視為「新增／編輯口味」，改用新增口味 API 補齊尚未建立的口味。
    async function saveProductGroup() {
        if (draft.groupId) return saveAdditionalVariants();
        const requestId = "wiz-pg-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2);
        const variants = draft.productDrafts.map(function (item) {
            return {
                variant_name: item.name.trim(), specs: item.specs.trim(),
                price: Math.round(Number(item.pickupPrice)), pickup_price: Math.round(Number(item.pickupPrice)),
                delivery_price: Math.round(Number(item.deliveryPrice)), unit: item.unit.trim(),
                enabled: true, description: item.description.trim(),
                image_url: /^https?:\/\//i.test(item.photo || "") ? item.photo : null
            };
        });
        const result = await app().createProductGroup({
            request_id: requestId, name: draft.groupMeta.name.trim(), description: draft.groupMeta.description.trim(),
            enabled: true, variants: variants
        });
        if (result.error || result.skipped) throw new Error(friendlyError(result, "主商品儲存失敗，請稍後再試一次"));
        if (result.data && result.data.duplicate) {
            message("偵測到重複提交，已忽略這次重複的建立請求。");
            return true;
        }
        draft.groupId = result.data.id;
        const serverVariants = result.data.variants || [];
        draft.productDrafts.forEach(function (item, index) {
            const row = serverVariants[index];
            item.productId = row ? row.id : (result.data.variantIds && result.data.variantIds[index]);
        });
        draft.productIds = draft.productDrafts.map(function (item) { return item.productId; }).filter(Boolean);
        saveDraft();
        // 圖片上傳走既有的單一商品圖片上傳端點（口味在 products 表內本來就是一般商品列）
        for (const item of draft.productDrafts) {
            const file = files.get(item.key);
            if (file && !item.photo && item.productId) {
                const uploaded = await app().uploadProductImage(item.productId, file);
                if (uploaded.data && uploaded.data.image_url) {
                    item.photo = uploaded.data.image_url;
                    saveDraft();
                }
            }
        }
        message("主商品與所有口味都已經儲存好了");
        return true;
    }

    // 已建立主商品後（例如使用者上一步失敗重試才會走到這裡），把尚未取得 productId 的口味卡
    // 透過「新增口味」API 逐一補上，絕不重新呼叫建立主商品（避免建立第二個主商品）。
    async function saveAdditionalVariants() {
        for (const item of draft.productDrafts) {
            if (item.productId) continue;
            const payload = {
                variant_name: item.name.trim(), specs: item.specs.trim(),
                price: Math.round(Number(item.pickupPrice)), pickup_price: Math.round(Number(item.pickupPrice)),
                delivery_price: Math.round(Number(item.deliveryPrice)), unit: item.unit.trim(),
                enabled: true, description: item.description.trim(),
                image_url: /^https?:\/\//i.test(item.photo || "") ? item.photo : null,
                request_id: "wiz-pgv-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2)
            };
            const result = await app().addProductGroupVariant(draft.groupId, payload);
            if (result.error || result.skipped) throw new Error(friendlyError(result, "口味儲存失敗，請稍後再試一次"));
            if (!(result.data && result.data.duplicate)) item.productId = result.data.id;
            saveDraft();
            const file = files.get(item.key);
            if (file && !item.photo && item.productId) {
                const uploaded = await app().uploadProductImage(item.productId, file);
                if (uploaded.data && uploaded.data.image_url) {
                    item.photo = uploaded.data.image_url;
                    saveDraft();
                }
            }
        }
        draft.productIds = draft.productDrafts.map(function (item) { return item.productId; }).filter(Boolean);
        saveDraft();
        message("主商品與所有口味都已經儲存好了");
        return true;
    }

    function renderGroup() {
        element("wizard-step-content").innerHTML =
            '<div class="wizard-step-copy"><span>第二步</span><h2>設定這次團購</h2><p>開始日期會自動使用今天，團購會直接設為開放。</p></div>' +
            '<div id="wizard-group-form">' +
            formField("團購名稱", "name", draft.group.name, "例如：Pril 洗碗精團") +
            formField("截止日期", "endDate", draft.group.endDate, "", "date") +
            '<div class="wizard-form-group"><label>簡單備註</label><textarea class="form-control" data-field="notes" rows="3" placeholder="例如：售完為止，預計下週到貨">' +
            escapeHtml(draft.group.notes) + '</textarea><small class="wizard-field-error" data-error="notes" hidden></small></div></div>';
        const end = root.document.querySelector('[data-field="endDate"]');
        if (end) end.min = today();
    }

    function rememberGroup() {
        const form = element("wizard-group-form");
        if (!form) return;
        draft.group = {
            name: form.querySelector('[data-field="name"]').value.trim(),
            endDate: form.querySelector('[data-field="endDate"]').value,
            notes: form.querySelector('[data-field="notes"]').value.trim()
        };
        saveDraft();
    }

    async function saveGroup() {
        rememberGroup();
        const form = element("wizard-group-form");
        clearErrors(form);
        const errors = validateGroupDraft(draft.group);
        Object.keys(errors).forEach(function (field) { fieldError(form, field, errors[field]); });
        if (Object.keys(errors).length) {
            message("請先完成團購資料。", "error");
            return false;
        }
        if (!draft.groupBuyId) draft.groupBuyId = nextCode("GB", state().groupBuys.map(function (group) { return group.id; }));
        const group = {
            id: draft.groupBuyId, name: draft.group.name, startDate: today(), endDate: draft.group.endDate,
            status: "開放", notes: draft.group.notes, productIds: draft.productIds.slice(),
            stockSettings: Object.values(draft.stockSettings)
        };
        app().upsertLocalGroup(group);
        app().selectGroup(group.id);
        saveDraft();
        const result = await app().syncGroup(group);
        if (result.error || result.skipped) throw new Error(friendlyError(result, "團購儲存失敗，請稍後再試一次"));
        message("這次團購已經建立完成");
        return true;
    }

    function stockSetting(productId) {
        if (!draft.stockSettings[productId]) {
            draft.stockSettings[productId] = {
                productId: productId, stockEnabled: true,
                incomingQuantity: 0, reservedQuantity: 0, lowStockThreshold: 5
            };
        }
        return draft.stockSettings[productId];
    }

    function renderStock() {
        let html = '<div class="wizard-step-copy"><span>第三步</span><h2>設定商品數量</h2><p>客戶訂購成功後，系統會自動扣掉數量；取消訂購時會自動補回。</p></div>';
        draft.productIds.forEach(function (productId) {
            const product = state().products.find(function (item) { return item.id === productId; });
            const stock = stockSetting(productId);
            html += '<article class="wizard-stock-card" data-product-id="' + escapeHtml(productId) + '"><h4>' +
                escapeHtml(product.name) + '<small>' + escapeHtml(product.specs || "") + '</small></h4>' +
                '<label class="wizard-unlimited"><input type="checkbox" data-field="unlimited" ' + (stock.stockEnabled ? "" : "checked") +
                ' onchange="BeginnerWizard.toggleUnlimited(\'' + escapeHtml(productId) + '\')"> 這個商品不限制數量</label>' +
                '<div class="wizard-stock-grid ' + (stock.stockEnabled ? "" : "wizard-stock-disabled") + '">' +
                formField("進貨數量", "incomingQuantity", stock.incomingQuantity, "", "number") +
                formField("保留數量", "reservedQuantity", stock.reservedQuantity, "", "number") +
                '<div class="wizard-form-group wizard-sellable"><label>可以賣的數量</label><output data-output="sellable">' +
                calculateSellable(stock.incomingQuantity, stock.reservedQuantity) + '</output></div>' +
                formField("剩下幾份時提醒", "lowStockThreshold", stock.lowStockThreshold, "", "number") +
                '</div></article>';
        });
        element("wizard-step-content").innerHTML = html;
        root.document.querySelectorAll(".wizard-stock-card input").forEach(function (input) {
            input.addEventListener("input", function () { updateStockPreview(input.closest(".wizard-stock-card").dataset.productId); });
        });
        root.document.querySelectorAll(".wizard-stock-card").forEach(function (card) {
            const unlimited = card.querySelector('[data-field="unlimited"]').checked;
            card.querySelectorAll(".wizard-stock-grid input").forEach(function (input) { input.disabled = unlimited; });
        });
        saveDraft();
    }

    function rememberStock() {
        root.document.querySelectorAll(".wizard-stock-card").forEach(function (card) {
            const stock = stockSetting(card.dataset.productId);
            stock.stockEnabled = !card.querySelector('[data-field="unlimited"]').checked;
            ["incomingQuantity", "reservedQuantity", "lowStockThreshold"].forEach(function (field) {
                stock[field] = Math.max(0, Math.round(Number(card.querySelector('[data-field="' + field + '"]').value) || 0));
            });
        });
        saveDraft();
    }

    function updateStockPreview(productId) {
        const card = root.document.querySelector('.wizard-stock-card[data-product-id="' + productId.replace(/"/g, "") + '"]');
        if (!card) return;
        card.querySelector('[data-output="sellable"]').textContent = calculateSellable(
            card.querySelector('[data-field="incomingQuantity"]').value,
            card.querySelector('[data-field="reservedQuantity"]').value
        );
        rememberStock();
    }

    function toggleUnlimited(productId) {
        const card = root.document.querySelector('.wizard-stock-card[data-product-id="' + productId.replace(/"/g, "") + '"]');
        const unlimited = card.querySelector('[data-field="unlimited"]').checked;
        card.querySelector(".wizard-stock-grid").classList.toggle("wizard-stock-disabled", unlimited);
        card.querySelectorAll(".wizard-stock-grid input").forEach(function (input) { input.disabled = unlimited; });
        rememberStock();
    }

    async function saveStock() {
        rememberStock();
        let valid = true;
        root.document.querySelectorAll(".wizard-stock-card").forEach(function (card) {
            clearErrors(card);
            const stock = stockSetting(card.dataset.productId);
            if (stock.stockEnabled && stock.reservedQuantity > stock.incomingQuantity) {
                fieldError(card, "reservedQuantity", "保留數量不能大於進貨數量");
                valid = false;
            }
        });
        if (!valid) {
            message("請修正商品數量後再繼續。", "error");
            return false;
        }
        app().updateLocalStock(draft.groupBuyId, Object.values(draft.stockSettings));
        for (const productId of draft.productIds) {
            const result = await app().syncStock(draft.groupBuyId, stockSetting(productId));
            if (result.error || result.skipped) throw new Error(friendlyError(result, "商品數量儲存失敗，請稍後再試一次"));
        }
        message("商品數量已經設定完成");
        return true;
    }

    function products() {
        return draft.productIds.map(function (id) {
            return state().products.find(function (product) { return product.id === id; });
        }).filter(Boolean);
    }

    function currentProduct() {
        const list = products();
        const selected = list.find(function (product) { return product.id === draft.selectedProductId; }) || list[0];
        if (selected) draft.selectedProductId = selected.id;
        return selected;
    }

    function selector(id, handler) {
        return '<select class="form-control" id="' + id + '" onchange="' + handler + '">' +
            products().map(function (product) {
                return '<option value="' + escapeHtml(product.id) + '" ' + (product.id === draft.selectedProductId ? "selected" : "") + '>' +
                    escapeHtml(product.id + "｜" + product.name + (product.specs ? "（" + product.specs + "）" : "")) + '</option>';
            }).join("") + '</select>';
    }

    function lineText(product) {
        const group = state().groupBuys.find(function (item) { return item.id === draft.groupBuyId; });
        return app().lineNote(products(), {
            productId: product.id, title: "阿賢Easy購｜" + group.name,
            deadline: group.endDate || "", notes: group.notes || ""
        });
    }

    // 一個商品、多個口味：預設只產生「一篇」文案，列出所有口味（不再一個口味一篇）。
    function groupLineText() {
        const group = state().groupBuys.find(function (item) { return item.id === draft.groupBuyId; });
        return app().lineNoteGroup(products(), {
            groupName: draft.groupMeta.name, productGroupId: draft.groupId,
            deadline: group.endDate || "", notes: group.notes || ""
        });
    }

    function allLinePosted() {
        return draft && draft.productIds.length > 0 && draft.productIds.every(function (id) {
            return draft.linePostedProductIds.includes(id);
        });
    }

    function renderLineNote() {
        if (draft.isGrouped) return renderGroupLineNote();
        const product = currentProduct();
        const checked = draft.linePostedProductIds.includes(product.id);
        element("wizard-step-content").innerHTML =
            '<div class="wizard-step-copy"><span>第四步</span><h2>把商品介紹貼到 LINE</h2><p>一次處理一項商品，文案會自動帶入正確資料。</p></div>' +
            (products().length > 1 ? '<div class="wizard-form-group"><label>選擇商品</label>' + selector("wizard-note-product", "BeginnerWizard.changeProduct(this.value)") + '</div>' : "") +
            (product.photo ? '<img class="wizard-feature-image" src="' + escapeHtml(product.photo) + '" alt="' + escapeHtml(product.name) + '">' : "") +
            '<textarea class="form-control wizard-note-preview" id="wizard-note-text" rows="15" readonly>' + escapeHtml(lineText(product)) + '</textarea>' +
            '<button type="button" class="btn btn-primary btn-lg wizard-full-button" onclick="BeginnerWizard.copyLineNote()"><i class="fa-solid fa-copy"></i> 複製 LINE 文案</button>' +
            '<ol class="wizard-simple-steps"><li>打開 LINE 群組</li><li>進入記事本</li><li>上傳商品圖片</li><li>貼上剛才的文案</li><li>按發布</li></ol>' +
            '<label class="wizard-confirm-check"><input type="checkbox" ' + (checked ? "checked" : "") + ' onchange="BeginnerWizard.markLinePosted(this.checked)"> 我已經貼到 LINE 記事本</label>' +
            (products().length > 1 ? '<p class="wizard-small-note">已完成 ' + draft.linePostedProductIds.length + "／" + draft.productIds.length + " 項商品</p>" : "");
        updateFooter();
        saveDraft();
    }

    // 一個商品、多個口味：同一主商品只產生一篇文案，所有口味都列在裡面（見 line-note.js generateGroupLineNote）。
    function renderGroupLineNote() {
        const checked = allLinePosted();
        const list = products();
        const firstPhoto = (list[0] || {}).photo;
        element("wizard-step-content").innerHTML =
            '<div class="wizard-step-copy"><span>第四步</span><h2>把商品介紹貼到 LINE</h2><p>這個商品有不同口味，系統已經把所有口味合併成一篇文案。</p></div>' +
            (firstPhoto ? '<img class="wizard-feature-image" src="' + escapeHtml(firstPhoto) + '" alt="' + escapeHtml(draft.groupMeta.name) + '">' : "") +
            '<textarea class="form-control wizard-note-preview" id="wizard-note-text" rows="18" readonly>' + escapeHtml(groupLineText()) + '</textarea>' +
            '<button type="button" class="btn btn-primary btn-lg wizard-full-button" onclick="BeginnerWizard.copyLineNote()"><i class="fa-solid fa-copy"></i> 複製 LINE 文案</button>' +
            '<ol class="wizard-simple-steps"><li>打開 LINE 群組</li><li>進入記事本</li><li>上傳商品圖片</li><li>貼上剛才的文案</li><li>按發布</li></ol>' +
            '<label class="wizard-confirm-check"><input type="checkbox" ' + (checked ? "checked" : "") + ' onchange="BeginnerWizard.markLinePosted(this.checked)"> 我已經貼到 LINE 記事本</label>';
        updateFooter();
        saveDraft();
    }

    function changeProduct(productId) {
        draft.selectedProductId = productId;
        saveDraft();
        if (draft.step === 4) renderLineNote();
        if (draft.step === 5) renderPublish();
    }

    async function copyLineNote() {
        const text = element("wizard-note-text").value;
        try {
            await root.navigator.clipboard.writeText(text);
        } catch (_error) {
            element("wizard-note-text").select();
            root.document.execCommand("copy");
        }
        const product = currentProduct();
        if (product && !draft.copiedProductIds.includes(product.id)) draft.copiedProductIds.push(product.id);
        saveDraft();
        message("文案已複製，現在可以到 LINE 群組記事本貼上。");
    }

    // 一個商品、多個口味的合併文案只有「一個」勾選框，勾選／取消時視為所有口味一起標記完成／未完成。
    function markLinePosted(checked) {
        if (draft.isGrouped) {
            draft.linePostedProductIds = checked ? draft.productIds.slice() : [];
            saveDraft();
            renderLineNote();
            return;
        }
        const product = currentProduct();
        draft.linePostedProductIds = draft.linePostedProductIds.filter(function (id) { return id !== product.id; });
        if (checked) draft.linePostedProductIds.push(product.id);
        saveDraft();
        renderLineNote();
    }

    async function loadGroups() {
        const select = element("wizard-line-group");
        if (!select || select.dataset.loaded === "true") return;
        const result = await app().lineGroups();
        if (result.error || result.skipped) {
            select.innerHTML = '<option value="">LINE 群組尚未連線</option>';
            message("LINE 群組尚未連線，請先到設定頁完成連線。", "error");
            return;
        }
        const groups = result.data || [];
        select.innerHTML = groups.length ? groups.map(function (group) {
            return '<option value="' + escapeHtml(group.group_id) + '">' + escapeHtml(group.display_name || "未命名群組") + '</option>';
        }).join("") : '<option value="">目前找不到可發布的 LINE 群組</option>';
        select.dataset.loaded = "true";
        if (draft.selectedLineGroupId && groups.some(function (group) { return group.group_id === draft.selectedLineGroupId; })) {
            select.value = draft.selectedLineGroupId;
        } else if (groups[0]) {
            select.value = groups[0].group_id;
            selectLineGroup(groups[0].group_id);
        }
    }

    function renderPublish() {
        if (draft.isGrouped && !draft.publishSeparately) return renderGroupPublish();
        const product = currentProduct();
        const group = state().groupBuys.find(function (item) { return item.id === draft.groupBuyId; });
        const price = Number(product.pickupPrice == null ? product.price : product.pickupPrice);
        const published = draft.publishedProductIds.includes(product.id);
        element("wizard-step-content").innerHTML =
            '<div class="wizard-step-copy"><span>第五步</span><h2>發布訂購按鈕</h2><p>選擇 LINE 群組後，把商品訂購卡發布出去。</p></div>' +
            (draft.isGrouped ? '<p class="wizard-small-note"><button type="button" class="wizard-text-button" onclick="BeginnerWizard.toggleGroupPublishMode()">改回發布一張合併商品卡</button></p>' : "") +
            (products().length > 1 ? '<div class="wizard-form-group"><label>選擇商品</label>' + selector("wizard-publish-product", "BeginnerWizard.changeProduct(this.value)") + '</div>' : "") +
            '<div class="wizard-card-preview">' + (product.photo ? '<img src="' + escapeHtml(product.photo) + '" alt="' + escapeHtml(product.name) + '">' : "") +
            '<div><h4>' + escapeHtml(product.name) + '</h4><p>' + escapeHtml(product.specs || "無規格") + '</p><strong>NT$ ' +
            price.toLocaleString() + "／" + escapeHtml(product.unit || "份") + '</strong><p>截止日期：' + escapeHtml(group.endDate) +
            '</p><div class="wizard-quantity-preview"><span>1份</span><span>2份</span><span>3份</span></div></div></div>' +
            '<div class="wizard-form-group"><label>選擇 LINE 群組</label><select class="form-control" id="wizard-line-group" onchange="BeginnerWizard.selectLineGroup(this.value)"><option value="">正在讀取 LINE 群組…</option></select><small class="wizard-field-error" data-error="lineGroup" hidden></small></div>' +
            '<button type="button" class="btn btn-primary btn-lg wizard-full-button" onclick="BeginnerWizard.publishCard()"><i class="fa-brands fa-line"></i> ' +
            (published ? "再次發布到 LINE 群組" : "發布到 LINE 群組") + '</button><p class="wizard-small-note">' +
            (published ? "✓ 這項商品的訂購卡已發布" : "已發布 " + draft.publishedProductIds.length + "／" + draft.productIds.length + " 項商品") + '</p>';
        loadGroups();
    }

    // 一個商品、多個口味：預設只發布「一張」合併商品卡（客戶點卡後在 LIFF 選口味），
    // 這裡是唯一預設路徑；「分開發布每個口味」是管理者主動切換才會用到的既有單一商品流程。
    function renderGroupPublish() {
        const group = state().groupBuys.find(function (item) { return item.id === draft.groupBuyId; });
        const list = products();
        const firstPhoto = (list[0] || {}).photo;
        const published = draft.publishedProductIds.length > 0 && draft.productIds.every(function (id) { return draft.publishedProductIds.includes(id); });
        element("wizard-step-content").innerHTML =
            '<div class="wizard-step-copy"><span>第五步</span><h2>發布訂購按鈕</h2><p>客戶會看到一張商品卡，點進去再選口味與數量。</p></div>' +
            '<div class="wizard-card-preview">' + (firstPhoto ? '<img src="' + escapeHtml(firstPhoto) + '" alt="' + escapeHtml(draft.groupMeta.name) + '">' : "") +
            '<div><h4>' + escapeHtml(draft.groupMeta.name) + '</h4><p>共有 ' + list.length + ' 種口味／款式</p><p>截止日期：' + escapeHtml(group.endDate) + '</p></div></div>' +
            '<div class="wizard-form-group"><label>選擇 LINE 群組</label><select class="form-control" id="wizard-line-group" onchange="BeginnerWizard.selectLineGroup(this.value)"><option value="">正在讀取 LINE 群組…</option></select><small class="wizard-field-error" data-error="lineGroup" hidden></small></div>' +
            '<button type="button" class="btn btn-primary btn-lg wizard-full-button" onclick="BeginnerWizard.publishGroupCard()"><i class="fa-brands fa-line"></i> ' +
            (published ? "再次發布合併商品卡" : "發布合併商品卡") + '</button>' +
            '<p class="wizard-small-note">' + (published ? "✓ 合併商品卡已發布" : "尚未發布") + '</p>' +
            '<p class="wizard-small-note"><button type="button" class="wizard-text-button" onclick="BeginnerWizard.toggleGroupPublishMode()">改成分開發布每個口味</button></p>';
        loadGroups();
    }

    function toggleGroupPublishMode() {
        draft.publishSeparately = !draft.publishSeparately;
        saveDraft();
        renderPublish();
    }

    function selectLineGroup(value) {
        draft.selectedLineGroupId = value;
        saveDraft();
    }

    async function publishGroupCard() {
        if (busy) return;
        const groupId = element("wizard-line-group").value || draft.selectedLineGroupId;
        if (!groupId) {
            message("LINE 群組尚未連線，請先到設定頁完成連線。", "error");
            return;
        }
        const repeated = draft.publishedProductIds.length > 0;
        const prompt = repeated
            ? "合併商品卡已經發布過，確定要再次發布嗎？"
            : "即將把合併商品卡發布到 LINE 群組，確定要發布嗎？";
        if (!root.confirm(prompt)) return;
        busy = true;
        updateFooter();
        try {
            const result = await app().publishGroupCard(draft.groupBuyId, draft.groupId, groupId);
            if (result.error || result.skipped) throw new Error(friendlyError(result, "發布失敗，請稍後再試一次"));
            draft.publishedProductIds = draft.productIds.slice();
            if (result.data && result.data.publication_id) draft.publicationIds[draft.groupId] = result.data.publication_id;
            draft.selectedLineGroupId = groupId;
            saveDraft();
            message("合併商品卡已發布，客戶現在可以點卡選口味與數量。");
            renderPublish();
        } catch (error) {
            message(error.message || "發布失敗，請稍後再試一次", "error");
        } finally {
            busy = false;
            updateFooter();
        }
    }

    async function publishCard() {
        if (busy) return;
        const product = currentProduct();
        const groupId = element("wizard-line-group").value || draft.selectedLineGroupId;
        if (!groupId) {
            message("LINE 群組尚未連線，請先到設定頁完成連線。", "error");
            return;
        }
        const repeated = needsRepublishConfirmation(draft.publishedProductIds, product.id);
        const prompt = repeated
            ? "「" + product.name + "」的訂購卡已經發布過，確定要再次發布嗎？"
            : "即將把商品訂購卡發布到 LINE 群組，確定要發布嗎？";
        if (!root.confirm(prompt)) return;
        busy = true;
        updateFooter();
        try {
            const result = await app().publishCard(draft.groupBuyId, product.id, groupId);
            if (result.error || result.skipped) throw new Error(friendlyError(result, "發布失敗，請稍後再試一次"));
            if (!draft.publishedProductIds.includes(product.id)) draft.publishedProductIds.push(product.id);
            if (result.data && result.data.publication_id) draft.publicationIds[product.id] = result.data.publication_id;
            draft.selectedLineGroupId = groupId;
            const nextProduct = products().find(function (item) { return !draft.publishedProductIds.includes(item.id); });
            if (nextProduct) draft.selectedProductId = nextProduct.id;
            saveDraft();
            message("訂購卡已發布，客戶現在可以直接選擇數量。");
            renderPublish();
        } catch (error) {
            message(error.message || "發布失敗，請稍後再試一次", "error");
        } finally {
            busy = false;
            updateFooter();
        }
    }

    function rememberStep() {
        if (!draft) return;
        if (draft.step === 1) rememberProducts();
        if (draft.step === 2) rememberGroup();
        if (draft.step === 3) rememberStock();
    }

    async function next() {
        if (!draft || busy) return;
        if (draft.step === 4 && !allLinePosted()) {
            message("請先勾選「我已經貼到 LINE 記事本」。", "error");
            return;
        }
        if (draft.step === 5) {
            if (!draft.productIds.every(function (id) { return draft.publishedProductIds.includes(id); })) {
                message("請先把每項商品的訂購卡發布完成。", "error");
                return;
            }
            draft.completed = true;
            saveDraft();
            showSummary();
            return;
        }
        busy = true;
        updateFooter();
        try {
            let saved = true;
            if (draft.step === 1) saved = await saveProducts();
            if (draft.step === 2) saved = await saveGroup();
            if (draft.step === 3) saved = await saveStock();
            if (saved) renderStep(draft.step + 1);
        } catch (error) {
            message(error.message || "儲存失敗，請稍後再試一次", "error");
        } finally {
            busy = false;
            updateFooter();
        }
    }

    function previous() {
        if (!draft || busy || draft.step <= 1) return;
        rememberStep();
        renderStep(draft.step - 1);
    }

    function summaryItem(label, complete, step) {
        return '<li class="' + (complete ? "complete" : "incomplete") + '"><span>' + (complete ? "✓" : "！") +
            '</span><div><strong>' + escapeHtml(label) + '</strong><small>' + (complete ? "已完成" : "尚未完成") +
            '</small></div>' + (complete ? "" : '<button class="btn btn-secondary btn-sm" onclick="BeginnerWizard.returnToStep(' + step + ')">回到這一步</button>') + '</li>';
    }

    function showSummary() {
        if (!draft) draft = loadDraft() || createDraft();
        showPanel("wizard-summary-panel");
        renderProgress(5);
        const group = state().groupBuys.find(function (item) { return item.id === draft.groupBuyId; });
        const stockDone = draft.productIds.length > 0 && draft.productIds.every(function (id) { return Boolean(draft.stockSettings[id]); });
        const published = draft.productIds.length > 0 && draft.productIds.every(function (id) { return draft.publishedProductIds.includes(id); });
        const sellable = draft.productIds.map(function (id) {
            const stock = draft.stockSettings[id];
            return stock && stock.stockEnabled ? calculateSellable(stock.incomingQuantity, stock.reservedQuantity) : "不限量";
        }).join("、") || "尚未設定";
        element("wizard-summary-content").innerHTML =
            '<h2>開團完成</h2><dl class="wizard-summary-meta"><dt>團購名稱</dt><dd>' + escapeHtml(group ? group.name : "尚未建立") +
            '</dd><dt>截止日期</dt><dd>' + escapeHtml(group ? group.endDate : "尚未設定") + '</dd><dt>商品數量</dt><dd>' +
            draft.productIds.length + ' 項</dd><dt>可賣數量</dt><dd>' + escapeHtml(sellable) + '</dd></dl><ul class="wizard-summary-list">' +
            summaryItem("商品資料", draft.productIds.length > 0, 1) + summaryItem("這次團購", Boolean(group), 2) +
            summaryItem("商品數量", stockDone, 3) + summaryItem("LINE 文案", allLinePosted(), 4) +
            summaryItem("商品卡發布", published, 5) + '</ul><p class="wizard-complete-message">' +
            (published ? "客戶現在可以在 LINE 商品卡直接選擇數量。" : "還有項目尚未完成，請使用上方按鈕返回處理。") + '</p>';
    }

    function returnToStep(step) {
        draft.completed = false;
        renderStep(step);
    }

    function viewOrders() {
        close();
        app().switchView("orders");
    }

    function home() {
        close();
        app().switchView("dashboard");
    }

    return {
        STORAGE_KEY: STORAGE_KEY,
        addFlavor: addFlavor,
        calculateSellable: calculateSellable,
        changeProduct: changeProduct,
        clearDraft: clearDraft,
        close: close,
        copyLineNote: copyLineNote,
        createDraft: createDraft,
        friendlyError: friendlyError,
        goToSettings: goToSettings,
        home: home,
        markLinePosted: markLinePosted,
        needsRepublishConfirmation: needsRepublishConfirmation,
        next: next,
        nextCode: nextCode,
        open: open,
        previous: previous,
        previewImage: previewImage,
        publishCard: publishCard,
        publishGroupCard: publishGroupCard,
        removeFlavor: removeFlavor,
        resume: resume,
        returnToStep: returnToStep,
        selectLineGroup: selectLineGroup,
        setGrouped: setGrouped,
        showSummary: showSummary,
        startFresh: startFresh,
        toggleGroupPublishMode: toggleGroupPublishMode,
        toggleUnlimited: toggleUnlimited,
        updateStockPreview: updateStockPreview,
        validateGroupDraft: validateGroupDraft,
        validateProductDraft: validateProductDraft,
        viewOrders: viewOrders
    };
});
