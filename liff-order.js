/* 阿賢 Easy 購｜LIFF 客戶端下單頁邏輯
 * 安全原則：
 *   - idToken 只放記憶體（模組變數），絕不寫入 localStorage / sessionStorage。
 *   - URL 只讀 groupBuyId / productId / quantity / action；永不從 URL 讀 userId / token / 客戶資料。
 *   - 成功畫面一律以 Worker 回應為準，前端不自行假裝成功。
 *   - 錯誤訊息只顯示允許清單內的中文，絕不外露 token / SQL / stack / channel id。
 */
(function () {
    "use strict";

    var WORKER = "https://ah-hsien-easy-buy-line.vannyai.workers.dev";

    // ── 記憶體狀態（不落地）───────────────────────────────
    var idToken = null;            // 只存記憶體
    var liffId = null;
    var lastErrorIsAuth = false;   // 錯誤畫面重試鈕的行為依據
    var state = {
        groupBuyId: "",
        productId: "",
        action: "",
        quantity: 1,
        product: null,             // { id,name,specs,unit,image_url,price,pickup_price,delivery_price }
        order: null,               // 我的目前訂單
        stats: null,
        pickupType: "自取",
        address: "",                // 客戶外送地址（記憶體；來自本人 my-order/session）
        hasAddress: false,
        submitting: false
    };

    var ALLOWED_ERRORS = {
        login: "LINE 登入失敗請重新開啟頁面",
        auth: "無法驗證您的 LINE 身分",
        notFound: "找不到此團購活動",
        expired: "此團購已截止",
        closed: "商品目前未開放訂購",
        saveFail: "訂單儲存失敗請重新嘗試",
        statsFail: "目前無法讀取訂購統計",
        noCustomer: "客戶資料尚未綁定",
        noAddress: "外送地址尚未設定",
        network: "網路連線異常"
    };

    function AppError(message, opts) {
        this.message = message;
        this.isAuth = !!(opts && opts.isAuth);
    }

    // ── DOM 小工具 ───────────────────────────────
    function $(id) { return document.getElementById(id); }
    function show(id) { $(id).classList.remove("hidden"); }
    function hide(id) { $(id).classList.add("hidden"); }
    function text(id, value) { $(id).textContent = value; }
    function ntd(value) { return "NT$ " + (Number(value) || 0).toLocaleString("zh-TW"); }

    function showOnly(viewId) {
        ["view-loading", "view-error", "view-main", "view-success"].forEach(function (v) {
            if (v === viewId) show(v); else hide(v);
        });
    }

    // ── URL 參數（白名單）───────────────────────────────
    // 只解析 groupBuyId / productId / quantity / action，永不讀取 userId / token / 客戶資料。
    function parseQuery(search) {
        var p = new URLSearchParams(search || "");
        return {
            groupBuyId: String(p.get("groupBuyId") || "").trim(),
            productId: String(p.get("productId") || "").trim(),
            action: String(p.get("action") || "").trim(),
            quantity: p.get("quantity")
        };
    }

    // LINE 在外部瀏覽器 / 桌機 / 登入導向時，會把原始 query 包進 liff.state 參數，
    // 其值可能是「?groupBuyId=..&productId=..」或「/path?groupBuyId=..」形式。
    // 取出其中的 query 部分（URLSearchParams 已解碼一次；必要時再解一次仍失敗則保留原字串）。
    function queryFromLiffState(search) {
        var raw = new URLSearchParams(search || "").get("liff.state");
        if (!raw) return "";
        // 若仍是編碼字串（含 %3F / %3D 之類），再解一次
        if (/%(3[fdF]|26)/.test(raw)) {
            try { raw = decodeURIComponent(raw); } catch (e) { /* 保留原字串 */ }
        }
        var qi = raw.indexOf("?");
        return qi >= 0 ? raw.slice(qi + 1) : raw;
    }

    // 依序嘗試多個來源：直接 URL → liff.state；取第一個帶得出 groupBuyId 的來源整組採用。
    function resolveParams() {
        var candidates = [window.location.search];
        var stateQ = queryFromLiffState(window.location.search);
        if (stateQ) candidates.push(stateQ);

        var picked = null;
        for (var i = 0; i < candidates.length; i++) {
            var parsed = parseQuery(candidates[i]);
            if (parsed.groupBuyId) { picked = parsed; break; }
        }
        if (!picked) picked = parseQuery(window.location.search);

        state.groupBuyId = picked.groupBuyId;
        state.productId = picked.productId;
        state.action = picked.action;
        var q = parseInt(picked.quantity, 10);
        state.quantity = (Number.isInteger(q) && q >= 1 && q <= 99) ? q : 1;
    }

    // ── 有效單價（自取→pickup_price||price，外送→delivery_price||price）──
    function effectivePrice(product, pickupType) {
        if (!product) return 0;
        var base = Number(product.price) || 0;
        if (pickupType === "自取") return product.pickup_price == null ? base : Number(product.pickup_price);
        if (pickupType === "外送") return product.delivery_price == null ? base : Number(product.delivery_price);
        return base;
    }

    // ── 通用 API 呼叫，統一錯誤映射為允許清單 ───────────────
    function apiRequest(path, options, fallbackMessage) {
        options = options || {};
        var res;
        return fetch(WORKER + path, options)
            .catch(function () { throw new AppError(ALLOWED_ERRORS.network); })
            .then(function (r) {
                res = r;
                return r.json().catch(function () { return {}; });
            })
            .then(function (body) {
                if (res.ok) return body;
                var raw = body && typeof body.error === "string" ? body.error : "";
                if (res.status === 401) throw new AppError(ALLOWED_ERRORS.auth, { isAuth: true });
                if (res.status === 404) throw new AppError(ALLOWED_ERRORS.notFound);
                if (res.status === 409) {
                    if (/截止/.test(raw)) throw new AppError(ALLOWED_ERRORS.expired);
                    if (/停售|未開放/.test(raw)) throw new AppError(ALLOWED_ERRORS.closed);
                    if (/地址/.test(raw)) throw new AppError(ALLOWED_ERRORS.noAddress);
                    throw new AppError(fallbackMessage || ALLOWED_ERRORS.saveFail);
                }
                // 其他狀態一律回退安全訊息，絕不外露 raw 內容
                throw new AppError(fallbackMessage || ALLOWED_ERRORS.saveFail);
            });
    }

    // ── 啟動流程 ───────────────────────────────
    function boot() {
        text("loading-text", "正在開啟訂購頁…");
        showOnly("view-loading");

        // 1) 取得 LIFF ID（不 hardcode）
        apiRequest("/api/liff/config", {}, ALLOWED_ERRORS.login)
            .then(function (cfg) {
                liffId = cfg && cfg.liffId;
                if (!liffId) throw new AppError(ALLOWED_ERRORS.login);
                return liff.init({ liffId: liffId });
            })
            .catch(function (e) { throw normalizeLiffError(e, ALLOWED_ERRORS.login); })
            .then(function () {
                // 先 liff.init，再解析參數：外部瀏覽器 / 桌機 / 登入導向會把原始 query 包進
                // liff.state，且 init 完成後 window.location 可能才還原原始 URL。
                resolveParams();
                if (!liff.isLoggedIn()) {
                    liff.login({ redirectUri: window.location.href });
                    return new Promise(function () { /* 導向登入，永不 resolve */ });
                }
                // 集齊所有來源（直接 URL + liff.state）且 init 後仍沒有 groupBuyId 才判定找不到
                if (!state.groupBuyId) throw new AppError(ALLOWED_ERRORS.notFound);
                idToken = liff.getIDToken();
                if (!idToken) throw new AppError(ALLOWED_ERRORS.auth, { isAuth: true });
                // 2) 以 Worker 驗證 id_token
                return apiRequest("/api/liff/session", jsonBody({ idToken: idToken }), ALLOWED_ERRORS.auth);
            })
            .then(function () { return loadInitial(); })
            .catch(function (e) { failFromError(e); });
    }

    function normalizeLiffError(e, fallback) {
        if (e instanceof AppError) return e;
        return new AppError(fallback || ALLOWED_ERRORS.login);
    }

    function jsonBody(obj, extraHeaders) {
        var headers = { "content-type": "application/json" };
        if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
        return { method: "POST", headers: headers, body: JSON.stringify(obj) };
    }

    // ── 初次載入資料 ───────────────────────────────
    function loadInitial() {
        return loadMyOrder()
            .then(function () {
                if (state.productId) {
                    return loadProduct(state.productId).then(function () {
                        // URL 有帶 quantity（預選）；若我的訂單已有此品項，改用現有數量當預選
                        var mine = findMyItem(state.productId);
                        if (mine) state.quantity = clampQty(mine.quantity);
                        render();
                    });
                }
                // myorder 模式：只顯示我的訂單
                render();
            });
    }

    function loadMyOrder() {
        return apiRequest(
            "/api/liff/my-order?groupBuyId=" + encodeURIComponent(state.groupBuyId),
            { method: "GET", headers: { authorization: "Bearer " + idToken } },
            ALLOWED_ERRORS.saveFail
        ).then(function (data) {
            state.order = (data && data.order) || { items: [], pickupType: null, totalAmount: 0 };
            state.address = (state.order && typeof state.order.address === "string") ? state.order.address : "";
            state.hasAddress = detectAddress(state.order);
            // 取貨方式預設：沿用既有訂單，否則自取
            if (state.order.pickupType === "自取" || state.order.pickupType === "外送") {
                state.pickupType = state.order.pickupType;
            }
        });
    }

    function loadProduct(productId) {
        return apiRequest(
            "/api/liff/group-buys/" + encodeURIComponent(state.groupBuyId) + "/products/" + encodeURIComponent(productId),
            { method: "GET" },
            ALLOWED_ERRORS.notFound
        ).then(function (data) {
            if (!data || !data.product) throw new AppError(ALLOWED_ERRORS.notFound);
            var gbStatus = data.groupBuyStatus;
            if (gbStatus === "expired") throw new AppError(ALLOWED_ERRORS.expired);
            if (gbStatus === "closed") throw new AppError(ALLOWED_ERRORS.closed);
            state.product = data.product;
            state.stats = data.stats || null;
        });
    }

    // 地址偵測：LIFF my-order API 目前未回傳地址欄位。
    //   - 若回應含明確 address / hasAddress 欄位（未來擴充）→ 以其為準。
    //   - 既有外送訂單視同已設定地址（回頭客不被擋）。
    //   - 其餘一律視為未設定，外送需先設定地址（見報告備註）。
    function detectAddress(order) {
        if (!order) return false;
        if (typeof order.hasAddress === "boolean") return order.hasAddress;
        if (order.address != null) return String(order.address).trim() !== "";
        if (order.customer && order.customer.address != null) return String(order.customer.address).trim() !== "";
        if (order.pickupType === "外送") return true;
        return false;
    }

    function findMyItem(productId) {
        if (!state.order || !state.order.items) return null;
        for (var i = 0; i < state.order.items.length; i++) {
            if (state.order.items[i].productId === productId) return state.order.items[i];
        }
        return null;
    }

    function clampQty(q) {
        q = parseInt(q, 10);
        if (!Number.isInteger(q) || q < 1) return 1;
        if (q > 99) return 99;
        return q;
    }

    // 取消品項 / 整張訂單後，回到主訂購畫面並讓「確認訂購」可再次使用。
    // 解鎖 submitting、重算數量（目前商品仍在訂單→沿用其數量，否則回預設 1 可立即再加入），
    // 再重繪主畫面（含商品卡、我的訂單、統計），避免卡在成功 / 空白畫面。
    function resyncAfterCancel() {
        state.submitting = false;
        var mine = state.productId ? findMyItem(state.productId) : null;
        state.quantity = mine ? clampQty(mine.quantity) : 1;
        render();
    }

    // ── 畫面渲染 ───────────────────────────────
    function render() {
        showOnly("view-main");
        renderOrderPanel();
        renderMyOrder();
        renderStats();
    }

    function renderOrderPanel() {
        if (!state.productId || !state.product) {
            hide("order-panel");
            hide("stats-panel");
            return;
        }
        show("order-panel");
        var p = state.product;
        var img = $("product-image");
        if (p.image_url && /^https:\/\//i.test(p.image_url)) {
            img.src = p.image_url;
            img.alt = p.name || "";
            img.classList.remove("hidden");
        } else {
            img.classList.add("hidden");
        }
        text("product-name", p.name || "");
        text("product-specs", p.specs || "無規格");
        text("product-price", ntd(effectivePrice(p, state.pickupType)));
        text("product-unit", "/ " + (p.unit || "份"));
        text("price-hint", state.pickupType === "外送" ? "（外送價）" : "（自取價）");

        // 取貨方式按鈕
        var btns = document.querySelectorAll(".pickup-btn");
        for (var i = 0; i < btns.length; i++) {
            var active = btns[i].getAttribute("data-pickup") === state.pickupType;
            btns[i].classList.toggle("active", active);
        }
        // 外送才顯示配送地址欄；自取隱藏。地址欄只在此帶入既有值，打字時不重繪以免游標跳動。
        var isDelivery = state.pickupType === "外送";
        var addrInput = $("address-input");
        $("address-field").classList.toggle("hidden", !isDelivery);
        if (document.activeElement !== addrInput) addrInput.value = state.address || "";
        addrInput.disabled = state.submitting;
        var needAddress = isDelivery && String(addrInput.value || "").trim() === "";
        $("address-hint").classList.toggle("hidden", !needAddress);

        text("qty-value", String(state.quantity));
        $("qty-minus").disabled = state.quantity <= 1 || state.submitting;
        $("qty-plus").disabled = state.quantity >= 99 || state.submitting;

        text("subtotal", ntd(effectivePrice(p, state.pickupType) * state.quantity));

        $("confirm-btn").disabled = state.submitting || needAddress;
        $("confirm-btn").textContent = state.submitting ? "訂購中…" : "確認訂購";
    }

    function renderMyOrder() {
        var listEl = $("myorder-list");
        var items = (state.order && state.order.items) || [];
        if (!items.length) {
            listEl.innerHTML = '<div class="empty-hint">目前尚無訂購紀錄</div>';
            return;
        }
        var html = "";
        items.forEach(function (it) {
            html += '<div class="my-item">' +
                '<div class="my-item-info">' +
                    '<div class="my-item-name">' + escapeHtml(it.productName || it.productId) + '</div>' +
                    '<div class="my-item-meta">' + Number(it.quantity) + " 份 · " + escapeHtml(it.pickupType || state.order.pickupType || "") +
                        " · " + ntd(it.amount) + '</div>' +
                '</div>' +
                '<div class="my-item-actions">' +
                    '<button type="button" class="btn btn-secondary btn-sm" data-edit="' + escapeAttr(it.productId) + '">修改</button>' +
                    '<button type="button" class="btn btn-danger btn-sm" data-remove="' + escapeAttr(it.productId) + '">移除</button>' +
                '</div>' +
            '</div>';
        });
        html += '<div class="subtotal-row" style="margin-top:12px;"><span>訂單總額</span><span class="subtotal-amount">' +
            ntd(state.order.totalAmount) + '</span></div>';
        html += '<button type="button" id="cancel-order-btn" class="btn btn-danger">取消整張訂單</button>';
        listEl.innerHTML = html;

        // 綁定按鈕
        listEl.querySelectorAll("[data-edit]").forEach(function (b) {
            b.addEventListener("click", function () { onEditItem(b.getAttribute("data-edit")); });
        });
        listEl.querySelectorAll("[data-remove]").forEach(function (b) {
            b.addEventListener("click", function () { onRemoveItem(b.getAttribute("data-remove")); });
        });
        var co = $("cancel-order-btn");
        if (co) co.addEventListener("click", onCancelOrder);
    }

    function renderStats() {
        if (!state.productId) { hide("stats-panel"); return; }
        show("stats-panel");
        var body = $("stats-body");
        var s = state.stats;
        if (!s) {
            body.innerHTML = '<div class="notice notice-warn">' + ALLOWED_ERRORS.statsFail + '</div>';
            return;
        }
        var per = (s.perProduct || []).map(function (row) {
            var name = (state.product && row.productId === state.product.id) ? (state.product.name || row.productId) : row.productId;
            return escapeHtml(name) + " " + Number(row.quantity) + "組";
        }).join("、");
        body.innerHTML =
            '<div class="stats-line">目前已有 <span class="stats-strong">' + Number(s.buyerCount) + '</span> 人購買</div>' +
            '<div class="stats-line">目前共訂購 <span class="stats-strong">' + Number(s.totalQuantity) + '</span> 組</div>' +
            (per ? '<div class="stats-per">各商品：' + per + '</div>' : "");
    }

    // ── 互動 ───────────────────────────────
    function bindStaticEvents() {
        document.querySelectorAll(".pickup-btn").forEach(function (b) {
            b.addEventListener("click", function () {
                if (state.submitting) return;
                state.pickupType = b.getAttribute("data-pickup");
                renderOrderPanel();
            });
        });
        $("qty-minus").addEventListener("click", function () {
            if (state.submitting) return;
            state.quantity = clampQty(state.quantity - 1);
            renderOrderPanel();
        });
        $("qty-plus").addEventListener("click", function () {
            if (state.submitting) return;
            state.quantity = clampQty(state.quantity + 1);
            renderOrderPanel();
        });
        $("address-input").addEventListener("input", function () {
            state.address = $("address-input").value;
            // 打字即時更新提示與確認鈕，但不整頁重繪（避免游標跳動）。
            var needAddress = state.pickupType === "外送" && String(state.address).trim() === "";
            $("address-hint").classList.toggle("hidden", !needAddress);
            if (state.product && state.productId) $("confirm-btn").disabled = state.submitting || needAddress;
        });
        $("confirm-btn").addEventListener("click", onConfirm);
        $("cancel-btn").addEventListener("click", function () { closeWindow(); });
        $("close-btn").addEventListener("click", function () { closeWindow(); });

        $("error-retry").addEventListener("click", function () {
            if (lastErrorIsAuth) relogin(); else window.location.reload();
        });
        $("error-close").addEventListener("click", function () { closeWindow(); });

        $("success-edit").addEventListener("click", function () { render(); scrollTop(); });
        $("success-cancel-item").addEventListener("click", function () { onRemoveItem(state.productId, true); });
        $("success-view-all").addEventListener("click", function () { render(); $("myorder-panel").scrollIntoView({ behavior: "smooth" }); });
        $("success-close").addEventListener("click", function () { closeWindow(); });
    }

    function onConfirm() {
        if (state.submitting) return;
        if (!state.productId || !state.product) return;
        var deliveryAddress = String(state.address || "").trim();
        if (state.pickupType === "外送" && !deliveryAddress) {
            $("address-hint").classList.remove("hidden");
            return;
        }
        // 立即鎖住按鈕，直到 API 回應（防重複送出）
        state.submitting = true;
        renderOrderPanel();
        var payload = {
            idToken: idToken,
            groupBuyId: state.groupBuyId,
            productId: state.productId,
            quantity: state.quantity,
            pickupType: state.pickupType
        };
        // 外送才送地址（trim 後）；自取不夾帶。
        if (state.pickupType === "外送") payload.address = deliveryAddress;
        apiRequest("/api/liff/orders/set-quantity", jsonBody(payload), ALLOWED_ERRORS.saveFail)
        .then(function (data) {
            state.order = (data && data.order) || state.order;
            state.stats = (data && data.stats) || state.stats;
            if (state.order && typeof state.order.address === "string") state.address = state.order.address;
            state.hasAddress = detectAddress(state.order) || state.hasAddress;
            state.submitting = false;
            showSuccess(state.productId);      // 成功畫面以 API 回應為準
        })
        .catch(function (e) {
            state.submitting = false;
            renderOrderPanel();
            failFromError(e, true);            // 可返回訂購頁重試
        });
    }

    function onEditItem(productId) {
        if (state.submitting) return;
        state.productId = productId;
        showOnly("view-loading");
        loadProduct(productId)
            .then(function () {
                var mine = findMyItem(productId);
                if (mine) state.quantity = clampQty(mine.quantity);
                render();
                scrollTop();
            })
            .catch(function (e) { failFromError(e, true); });
    }

    function onRemoveItem(productId, fromSuccess) {
        if (state.submitting) return;
        state.submitting = true;
        apiRequest("/api/liff/orders/cancel-item", jsonBody({
            idToken: idToken,
            groupBuyId: state.groupBuyId,
            productId: productId
        }), ALLOWED_ERRORS.saveFail)
        .then(function (data) {
            state.order = (data && data.order) || state.order;
            state.stats = (data && data.stats) || state.stats;
            resyncAfterCancel();               // 解鎖 + 重算數量 + 回主畫面，確認鈕可再次使用
            if (fromSuccess) scrollTop();
        })
        .catch(function (e) { state.submitting = false; failFromError(e, true); });
    }

    function onCancelOrder() {
        if (state.submitting) return;
        state.submitting = true;
        apiRequest("/api/liff/orders/cancel-order", jsonBody({
            idToken: idToken,
            groupBuyId: state.groupBuyId
        }), ALLOWED_ERRORS.saveFail)
        .then(function (data) {
            state.order = (data && data.order) || { items: [], pickupType: null, totalAmount: 0 };
            state.stats = (data && data.stats) || state.stats;
            resyncAfterCancel();               // 解鎖 + 重算數量 + 回主畫面，確認鈕可再次使用
        })
        .catch(function (e) { state.submitting = false; failFromError(e, true); });
    }

    function showSuccess(productId) {
        var item = findMyItem(productId);
        showOnly("view-success");
        // 配送地址只顯示給本人：外送且有地址才顯示該列。
        var pickupNow = (item && item.pickupType) || (state.order && state.order.pickupType) || state.pickupType;
        var addrNow = String(state.address || "").trim();
        if (pickupNow === "外送" && addrNow) {
            text("success-address", addrNow);
            show("success-address-row");
        } else {
            hide("success-address-row");
        }
        if (item) {
            text("success-product", item.productName || (state.product && state.product.name) || productId);
            text("success-qty", Number(item.quantity) + " 份");
            text("success-pickup", item.pickupType || state.order.pickupType || state.pickupType);
            text("success-amount", ntd(item.amount));
            show("success-cancel-item");
        } else {
            // 品項已不在訂單（可能被設為 0 / 取消）→ 顯示為已取消狀態
            text("success-product", (state.product && state.product.name) || productId);
            text("success-qty", "0 份");
            text("success-pickup", state.pickupType);
            text("success-amount", ntd(0));
            hide("success-cancel-item");
        }
    }

    // ── 錯誤處理 ───────────────────────────────
    function failFromError(e, allowRetryOrder) {
        var msg = (e instanceof AppError) ? e.message : ALLOWED_ERRORS.network;
        var isAuth = (e instanceof AppError) && e.isAuth;
        fail(msg, isAuth);
    }

    function fail(message, isAuth) {
        lastErrorIsAuth = !!isAuth;
        text("error-message", message);
        // 任何錯誤都提供重試：驗證錯誤→重新登入；其餘（網路 / 找不到等）→重新整理重跑 init。
        text("error-retry", isAuth ? "重新登入" : "重新整理");
        show("error-retry");
        showOnly("view-error");
    }

    function relogin() {
        try {
            if (liff && liff.isLoggedIn && liff.isLoggedIn()) liff.logout();
        } catch (e) { /* 忽略 */ }
        window.location.reload();
    }

    function closeWindow() {
        // 1) LINE App 內（LIFF 瀏覽器）：正常關閉視窗並回到聊天室。
        var inClient = false;
        try {
            inClient = !!(typeof liff !== "undefined" && liff.isInClient && liff.isInClient());
        } catch (e) { inClient = false; }
        if (inClient) {
            try { liff.closeWindow(); return; } catch (e) { /* 落到下方 fallback */ }
        }

        // 2) 外部瀏覽器（電腦 Chrome / 手機 Safari）：liff.closeWindow() 一律無效，
        //    先嘗試關閉分頁（僅在此分頁是由 script 開啟時才會成功）。
        try { window.close(); } catch (e) { /* 忽略 */ }

        // 3) 分頁被瀏覽器擋下沒關掉 → 顯示手動關閉提示與回 LINE 的連結。
        window.setTimeout(function () {
            var hint = document.getElementById("close-hint");
            if (!hint) return;
            hint.classList.remove("hidden");
            try { hint.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { /* 忽略 */ }
        }, 400);
    }

    function scrollTop() { window.scrollTo({ top: 0, behavior: "smooth" }); }

    // ── 安全字串 ───────────────────────────────
    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function escapeAttr(s) { return escapeHtml(s); }

    // ── 進入點 ───────────────────────────────
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () { bindStaticEvents(); boot(); });
    } else {
        bindStaticEvents();
        boot();
    }
})();
