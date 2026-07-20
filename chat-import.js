// =====================================================================
// 截圖匯入訂單（chat-import.js）
// 把團購聊天截圖（貼文＋樓下 A+1/B+1 回覆）辨識成文字、解析成訂單。
// 架構規範：不引入框架/build，UMD 包純解析器（可 Node 測試），
// 瀏覽器 UI 函式掛 window，由 index.html onclick 呼叫。
// OCR 使用 Tesseract.js（CDN 延遲載入，需網路；辨識結果可手動修正）。
// =====================================================================
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.ChatImport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // ---- 純解析器（無 DOM 相依，Node 可測） ----

    const TOKEN_RE = /([A-Za-z])\s*[+＋]\s*(\d+)/g;          // A+1、B 2
    const PLUS_ONLY_RE = /^[+＋]\s*(\d+)$/;                    // 單純 +1
    const OPTION_RE = /^([A-Za-z])[\s.、．]*【(.+?)】/;        // A.【品名】
    const OPTION_PLAIN_RE = /^([A-Za-z])[.、．]\s*(\S.*)$/;    // A. 品名（無括號）
    const TIME_RE = /(上午|下午|凌晨|晚上|中午|昨天|今天|前天|星期[一二三四五六日天]|週[一二三四五六日])|\b\d{1,2}:\d{2}\b/;
    const NOISE_RE = /^(顯示更多|回覆|讚|收回|已讀|已編輯|轉傳|複製|\.{2,}|…)/;
    const META_RE = /(結單|收單|截止|開團|跟團|自取|面交|轉帳|匯款|運費)/;
    const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

    function extractPrice(line) {
        const m = line.match(/(?:\$|＄|NT\$?)\s*(\d+)/i) || line.match(/(\d+)\s*元/);
        return m ? parseInt(m[1], 10) : null;
    }

    // OCR 常把中文字間插空白，先收斂；保留英數 token 的原樣
    function normalizeOcrText(text) {
        return String(text || "")
            .replace(/[ \t]+(?=[一-鿿])/g, function (sp, offset, s) {
                const prev = s[offset - 1] || "";
                return /[一-鿿]/.test(prev) ? "" : sp;
            })
            .replace(/[｜|]/g, "")
            .replace(/　/g, " ");
    }

    function cleanNickname(line) {
        return line.replace(EMOJI_RE, "").replace(/[•·．.]+$/, "").trim();
    }

    /**
     * 解析聊天文字。
     * @returns {{options:Array<{key:string,name:string,price:number|null}>,
     *            basePrice:number|null, deliveryFee:number|null, headerName:string|null,
     *            orders:Array<{nickname:string, items:Array<{key:string, qty:number}>}>,
     *            warnings:string[]}}
     */
    function parseChatText(rawText) {
        const lines = String(rawText || "").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
        const options = [];
        const orders = [];
        const warnings = [];
        let basePrice = null;
        let deliveryFee = null;
        let headerName = null;
        let currentNick = null;

        function orderEntry(nick) {
            let e = orders.find(function (o) { return o.nickname === nick; });
            if (!e) { e = { nickname: nick, items: [] }; orders.push(e); }
            return e;
        }
        function addItem(entry, key, qty) {
            const ex = entry.items.find(function (i) { return i.key === key; });
            if (ex) ex.qty += qty; else entry.items.push({ key: key, qty: qty });
        }

        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];

            // 1) 品項選項行（A.【…】 或 A. …）
            let m = line.match(OPTION_RE) || line.match(OPTION_PLAIN_RE);
            if (m && !TIME_RE.test(line)) {
                const key = m[1].toUpperCase();
                if (!options.some(function (o) { return o.key === key; })) {
                    options.push({ key: key, name: m[2].replace(/】.*$/, "").trim(), price: extractPrice(line) });
                    continue;
                }
            }

            // 2) 訂購 token 行（A+1 B+2）
            TOKEN_RE.lastIndex = 0;
            const toks = Array.from(line.matchAll(TOKEN_RE));
            if (toks.length > 0) {
                if (!currentNick) {
                    warnings.push("有一行訂購「" + line + "」找不到訂購人，已略過，請於預覽表手動補上。");
                    continue;
                }
                const entry = orderEntry(currentNick);
                toks.forEach(function (t) { addItem(entry, t[1].toUpperCase(), parseInt(t[2], 10)); });
                continue;
            }

            // 3) 單純 +1（無字母）
            const pm = line.match(PLUS_ONLY_RE);
            if (pm) {
                if (!currentNick) {
                    warnings.push("有一行「" + line + "」找不到訂購人，已略過。");
                    continue;
                }
                const qty = parseInt(pm[1], 10);
                const entry = orderEntry(currentNick);
                if (options.length <= 1) {
                    addItem(entry, options.length === 1 ? options[0].key : "A", qty);
                } else {
                    addItem(entry, "?", qty);
                    warnings.push("「" + currentNick + "」只回了 +" + qty + "，但貼文有多個品項，請於預覽表指定品項。");
                }
                continue;
            }

            // 4) 外送/運費行（可能沒有 $ 符號，如「外送 +15」）
            if (/外送|運費|運資/.test(line) && line.length <= 15) {
                const dm = line.match(/(\d+)/);
                if (dm && deliveryFee === null) deliveryFee = parseInt(dm[1], 10);
                continue;
            }

            // 5) 時間戳：一則訊息結束，清掉目前訂購人
            if (TIME_RE.test(line)) { currentNick = null; continue; }

            // 5) 雜訊
            if (NOISE_RE.test(line)) continue;

            // 6) 主貼文行（# 開頭、含價格、或含團購關鍵字）
            if (line.charAt(0) === "#") {
                if (basePrice === null) basePrice = extractPrice(line);
                continue;
            }
            const price = extractPrice(line);
            if (price !== null) {
                if (/外送|運費/.test(line)) { deliveryFee = price; continue; }
                if (basePrice === null) {
                    basePrice = price;
                    const nm = line.match(/【(.+?)】\s*(\S[^$＄]*)/);
                    if (nm) headerName = (nm[1] + " " + nm[2]).replace(/\s+/g, " ").trim();
                    else {
                        const nm2 = line.match(/【(.+?)】/);
                        if (nm2) headerName = nm2[1].trim();
                    }
                    continue;
                }
                continue;
            }
            if (META_RE.test(line)) continue;

            // 7) 其餘短行 → 視為訂購人暱稱
            const nick = cleanNickname(line);
            if (nick && nick.length <= 20 && !/^\d+$/.test(nick)) currentNick = nick;
        }

        // 選項無標價時回填貼文基準價
        options.forEach(function (o) { if (o.price === null) o.price = basePrice; });

        // 貼文只有一個主商品、沒有 A/B 選項時，自動補一個選項
        if (options.length === 0 && orders.length > 0) {
            options.push({ key: "A", name: headerName || "（請輸入商品名）", price: basePrice });
            if (!headerName) warnings.push("無法從貼文辨識商品名稱，請於預覽表修改。");
        }
        options.forEach(function (o) {
            if (o.price === null) { o.price = 0; warnings.push("品項 " + o.key + "（" + o.name + "）沒有辨識到價格，已先填 0，請修正。"); }
        });

        return { options: options, basePrice: basePrice, deliveryFee: deliveryFee, headerName: headerName, orders: orders, warnings: warnings };
    }

    return { parseChatText: parseChatText, normalizeOcrText: normalizeOcrText, extractPrice: extractPrice };
});

// =====================================================================
// 以下為瀏覽器 UI（Node 測試時不執行）
// =====================================================================
if (typeof document !== "undefined") {
    (function () {
        "use strict";
        const TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
        let selectedImageFile = null;
        let lastParsed = null;

        function $(id) { return document.getElementById(id); }
        function setStatus(text) { const el = $("chat-import-status"); if (el) el.textContent = text; }

        // ---- Modal 開關 ----
        window.openChatImportModal = function () {
            resetChatImportModal();
            populateChatImportGroupBuys();
            if (typeof openModal === "function") openModal("chat-import-modal");
        };
        window.closeChatImportModal = function () {
            if (typeof closeModal === "function") closeModal("chat-import-modal");
        };
        function resetChatImportModal() {
            selectedImageFile = null;
            lastParsed = null;
            $("chat-import-file").value = "";
            $("chat-import-text").value = "";
            $("chat-import-preview-section").style.display = "none";
            $("chat-import-warnings").style.display = "none";
            $("chat-import-warnings").innerHTML = "";
            $("chat-import-execute-btn").disabled = true;
            $("chat-import-image-name").textContent = "尚未選擇圖片（也可直接把截圖 Ctrl+V 貼進本視窗，或跳過圖片直接貼文字）";
            setStatus("");
        }
        function populateChatImportGroupBuys() {
            const sel = $("chat-import-gb-select");
            if (!sel || typeof state === "undefined") return;
            sel.innerHTML = "";
            state.groupBuys.forEach(function (gb) {
                const opt = document.createElement("option");
                opt.value = gb.id;
                opt.textContent = gb.id + "：" + gb.name;
                if (gb.id === state.activeGroupBuyId) opt.selected = true;
                sel.appendChild(opt);
            });
        }

        // ---- 圖片來源：選檔或貼上 ----
        window.handleChatImportFile = function (input) {
            if (input.files && input.files[0]) {
                selectedImageFile = input.files[0];
                $("chat-import-image-name").textContent = "已選擇：" + selectedImageFile.name;
            }
        };
        // 與 Excel 匯入精靈共用入口：第一步選「訂單-聊天截圖／文字」即開本 modal
        document.addEventListener("DOMContentLoaded", function () {
            const sel = document.getElementById("excel-import-type");
            if (!sel) return;
            sel.addEventListener("change", function () {
                if (sel.value !== "orders-chat") return;
                sel.value = "";
                if (typeof resetImportWizard === "function") resetImportWizard();
                window.openChatImportModal();
            });
        });

        document.addEventListener("paste", function (e) {
            const modal = $("chat-import-modal");
            if (!modal || !modal.classList.contains("show")) return;
            const items = (e.clipboardData || {}).items || [];
            for (let i = 0; i < items.length; i++) {
                if (items[i].type && items[i].type.indexOf("image") === 0) {
                    selectedImageFile = items[i].getAsFile();
                    $("chat-import-image-name").textContent = "已貼上剪貼簿圖片";
                    e.preventDefault();
                    return;
                }
            }
        });

        // ---- OCR ----
        function loadTesseract() {
            return new Promise(function (resolve, reject) {
                if (window.Tesseract) return resolve();
                const s = document.createElement("script");
                s.src = TESSERACT_CDN;
                s.onload = function () { resolve(); };
                s.onerror = function () { reject(new Error("無法載入 OCR 引擎，請確認網路連線。")); };
                document.head.appendChild(s);
            });
        }
        window.runChatImportOCR = async function () {
            if (!selectedImageFile) { alert("請先選擇或貼上截圖圖片。"); return; }
            const btn = $("chat-import-ocr-btn");
            btn.disabled = true;
            try {
                setStatus("載入 OCR 引擎中…（第一次使用需下載中文模型，約 10–30 秒）");
                await loadTesseract();
                const worker = await window.Tesseract.createWorker(["chi_tra", "eng"], 1, {
                    logger: function (m) {
                        if (m.status === "recognizing text") setStatus("辨識中… " + Math.round(m.progress * 100) + "%");
                    }
                });
                const result = await worker.recognize(selectedImageFile);
                await worker.terminate();
                const text = window.ChatImport.normalizeOcrText(result.data.text);
                $("chat-import-text").value = text;
                setStatus("辨識完成。請人工核對下方文字（OCR 可能認錯字），修正後按「解析文字」。");
            } catch (err) {
                setStatus("辨識失敗：" + err.message + "（可改用手動貼文字）");
            } finally {
                btn.disabled = false;
            }
        };

        // ---- 解析＋預覽 ----
        window.parseChatImportTextNow = function () {
            const text = $("chat-import-text").value;
            if (!text.trim()) { alert("沒有文字可解析。請先 OCR 或直接貼上聊天文字。"); return; }
            lastParsed = window.ChatImport.parseChatText(text);
            renderChatImportPreview();
        };

        function productSelectHtml(selectedKey) {
            let html = "";
            (lastParsed ? lastParsed.options : []).forEach(function (o) {
                html += '<option value="K:' + o.key + '"' + (selectedKey === o.key ? " selected" : "") + ">" +
                    o.key + "：" + escapeHtml(o.name) + "（$" + o.price + "）</option>";
            });
            if (typeof state !== "undefined") {
                state.products.filter(function (p) { return p.enabled !== false; }).forEach(function (p) {
                    html += '<option value="P:' + p.id + '">[既有] ' + escapeHtml(p.name) + "（$" + p.price + "）</option>";
                });
            }
            if (selectedKey === "?") html = '<option value="" selected>⚠ 請選擇品項</option>' + html;
            return html;
        }
        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, function (c) {
                return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
            });
        }

        function renderChatImportPreview() {
            const tbody = $("chat-import-preview-tbody");
            tbody.innerHTML = "";
            $("chat-import-warnings").innerHTML = "";
            lastParsed.orders.forEach(function (o) {
                o.items.forEach(function (it) {
                    appendPreviewRow(o.nickname, it.key, it.qty);
                });
            });
            const warnBox = $("chat-import-warnings");
            if (lastParsed.warnings.length > 0) {
                warnBox.innerHTML = "<strong>請注意：</strong><ul style='margin:6px 0 0 18px;'>" +
                    lastParsed.warnings.map(function (w) { return "<li>" + escapeHtml(w) + "</li>"; }).join("") + "</ul>";
                warnBox.style.display = "block";
            } else {
                warnBox.style.display = "none";
            }
            $("chat-import-preview-section").style.display = "block";
            $("chat-import-execute-btn").disabled = lastParsed.orders.length === 0;
            if (lastParsed.orders.length === 0) {
                warnBox.innerHTML += "<div>沒有解析到任何「暱稱＋A+1」訂購，請檢查文字內容。</div>";
                warnBox.style.display = "block";
            }
        }
        function appendPreviewRow(nickname, key, qty) {
            const tbody = $("chat-import-preview-tbody");
            const tr = document.createElement("tr");
            tr.innerHTML =
                '<td><input type="text" class="form-control ci-nick" value="' + escapeHtml(nickname) + '" style="min-width:90px;"></td>' +
                '<td><select class="form-control ci-prod" style="min-width:170px;">' + productSelectHtml(key) + "</select></td>" +
                '<td><input type="number" class="form-control ci-qty" value="' + (qty || 1) + '" min="1" style="width:70px;"></td>' +
                '<td><button class="btn btn-secondary" onclick="this.closest(\'tr\').remove()" title="刪除此列">&times;</button></td>';
            tbody.appendChild(tr);
        }
        window.addChatImportRow = function () {
            if (!lastParsed) lastParsed = { options: [], basePrice: null, deliveryFee: null, headerName: null, orders: [], warnings: [] };
            appendPreviewRow("", lastParsed.options.length > 0 ? lastParsed.options[0].key : "?", 1);
            $("chat-import-preview-section").style.display = "block";
            $("chat-import-execute-btn").disabled = false;
        };

        // ---- 正式匯入 ----
        window.executeChatImport = function () {
            if (typeof state === "undefined") { alert("系統狀態尚未初始化。"); return; }
            const gbId = $("chat-import-gb-select").value;
            if (!gbId) { alert("請先選擇要匯入的團購活動。"); return; }

            const rows = Array.from($("chat-import-preview-tbody").querySelectorAll("tr"));
            const parsedRows = [];
            for (let i = 0; i < rows.length; i++) {
                const nick = rows[i].querySelector(".ci-nick").value.trim();
                const prodVal = rows[i].querySelector(".ci-prod").value;
                const qty = parseInt(rows[i].querySelector(".ci-qty").value, 10);
                if (!nick) { alert("第 " + (i + 1) + " 列缺少訂購人暱稱。"); return; }
                if (!prodVal) { alert("第 " + (i + 1) + " 列（" + nick + "）尚未指定品項。"); return; }
                if (!qty || qty < 1) { alert("第 " + (i + 1) + " 列（" + nick + "）數量無效。"); return; }
                parsedRows.push({ nick: nick, prodVal: prodVal, qty: qty });
            }
            if (parsedRows.length === 0) { alert("沒有可匯入的訂購資料。"); return; }

            // 1) 準備商品：K:選項 → 依名稱找既有商品，找不到就新建；P:id → 直接用
            const keyToProduct = {};
            function nextProductId() {
                let max = 0;
                state.products.forEach(function (p) { const m = String(p.id).match(/^P(\d+)$/i); if (m) max = Math.max(max, parseInt(m[1], 10)); });
                return "P" + String(max + 1).padStart(3, "0");
            }
            function resolveProduct(prodVal) {
                if (prodVal.indexOf("P:") === 0) {
                    return state.products.find(function (p) { return p.id === prodVal.slice(2); }) || null;
                }
                const key = prodVal.slice(2); // K:A
                if (keyToProduct[key]) return keyToProduct[key];
                const opt = (lastParsed ? lastParsed.options : []).find(function (o) { return o.key === key; });
                if (!opt) return null;
                let prod = state.products.find(function (p) { return p.name === opt.name; });
                if (!prod) {
                    prod = { id: nextProductId(), name: opt.name, specs: "", price: opt.price || 0, unit: "件", photo: "", enabled: true };
                    state.products.push(prod);
                }
                keyToProduct[key] = prod;
                return prod;
            }

            // 2) 依暱稱彙整 items
            const byNick = {};
            for (let i = 0; i < parsedRows.length; i++) {
                const r = parsedRows[i];
                const prod = resolveProduct(r.prodVal);
                if (!prod) { alert("第 " + (i + 1) + " 列（" + r.nick + "）的品項無法解析。"); return; }
                if (!byNick[r.nick]) byNick[r.nick] = [];
                const ex = byNick[r.nick].find(function (it) { return it.productId === prod.id; });
                if (ex) ex.quantity += r.qty;
                else byNick[r.nick].push({ productId: prod.id, productName: prod.name, specs: prod.specs || "", quantity: r.qty, price: prod.price });
            }

            // 3) 客戶：暱稱完全相同 → 沿用；否則新建
            function nextCustomerId() {
                let max = 0;
                state.customers.forEach(function (c) { const m = String(c.id).match(/^A(\d+)$/i); if (m) max = Math.max(max, parseInt(m[1], 10)); });
                return "A" + String(max + 1).padStart(3, "0");
            }
            function nextOrderId() {
                let max = 0;
                state.orders.forEach(function (o) { const m = String(o.id).match(/^ORD(\d+)$/i); if (m) max = Math.max(max, parseInt(m[1], 10)); });
                return "ORD" + String(max + 1).padStart(5, "0");
            }

            // 先檢查覆寫情況，讓使用者知情
            const willOverwrite = [];
            Object.keys(byNick).forEach(function (nick) {
                const cust = state.customers.find(function (c) { return c.nickname === nick; });
                if (cust && state.orders.some(function (o) { return o.groupBuyId === gbId && o.customerId === cust.id; })) willOverwrite.push(nick);
            });
            if (willOverwrite.length > 0) {
                if (!confirm("以下客戶在此團購已有訂單，匯入將【覆寫】其商品明細：\n" + willOverwrite.join("、") + "\n\n確定繼續？")) return;
            }

            let newCustomers = 0, newOrders = 0, updatedOrders = 0;
            const today = new Date().toISOString().slice(0, 10);
            Object.keys(byNick).forEach(function (nick) {
                let cust = state.customers.find(function (c) { return c.nickname === nick; });
                if (!cust) {
                    cust = { id: nextCustomerId(), nickname: nick, phone: "", address: "", notes: "截圖匯入自動建立" };
                    state.customers.push(cust);
                    newCustomers++;
                }
                const items = byNick[nick];
                const total = items.reduce(function (s, it) { return s + it.quantity * it.price; }, 0);
                const idx = state.orders.findIndex(function (o) { return o.groupBuyId === gbId && o.customerId === cust.id; });
                if (idx > -1) {
                    state.orders[idx].items = items;
                    state.orders[idx].totalAmount = total;
                    state.orders[idx].customerNickname = cust.nickname;
                    updatedOrders++;
                } else {
                    state.orders.push({
                        id: nextOrderId(),
                        groupBuyId: gbId,
                        customerId: cust.id,
                        customerNickname: cust.nickname,
                        phone: cust.phone || "",
                        address: cust.address || "",
                        pickupType: "自取",
                        items: items,
                        totalAmount: total,
                        paymentStatus: "未付款",
                        orderStatus: "新訂單",
                        notes: "截圖匯入（" + today + "）",
                        createdDate: today,
                        checkedProductIds: []
                    });
                    newOrders++;
                }
            });

            saveStateToStorage();
            window.closeChatImportModal();
            if (typeof switchView === "function") switchView("orders");
            alert("截圖匯入完成！新增訂單 " + newOrders + " 筆、覆寫 " + updatedOrders + " 筆、自動建立客戶 " + newCustomers + " 位。\n（新訂單預設：自取／未付款，請視需要調整）");
        };
    })();
}
