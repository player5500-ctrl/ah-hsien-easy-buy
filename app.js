/* ==========================================================================
   阿賢Easy購管理系統 - 核心邏輯 & 資料控制 (app.js)
   ========================================================================== */

// --- HTML 跳脫（防 XSS）：所有渲染使用者/外部輸入的地方一律先經過此函式 ---
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// --- 客戶名稱解析（全站唯一入口，實作在 customer-name.js） ---
// 顯示優先順序：團主自訂名稱(customDisplayName) > LINE 原始名稱(lineDisplayName)
//              > legacy nickname > 訂單下單當時的歷史名稱 > 未知客戶
// 所有顯示客戶名稱的地方（訂單列表／詳情／依客戶整理／付款／配送／出貨／儀表板／
// 列印／Excel 匯出／搜尋排序）都必須呼叫這裡，避免只修好其中一頁。
function findCustomerById(customerId) {
    if (!customerId) return null;
    return state.customers.find(c => c.id === customerId) || null;
}

function customerDisplayName(customer, snapshot) {
    return CustomerName.resolveDisplayName(customer || {}, snapshot);
}

// 訂單顯示名稱：一律透過 customerId 關聯客戶資料取「目前」名稱，
// 找不到客戶時才回退訂單自身記錄的歷史名稱（customerNickname）。
function orderCustomerName(order) {
    if (!order) return CustomerName.UNKNOWN;
    return CustomerName.resolveDisplayName(findCustomerById(order.customerId) || {}, order.customerNickname);
}

// 供搜尋／排序使用（保證是字串，避免 undefined.toLowerCase 例外）
function orderCustomerNameForSort(order) {
    return String(orderCustomerName(order) || '');
}

// --- 系統資料狀態庫 ---
let state = {
    groupBuys: [],
    products: [],
    customers: [],
    orders: [],
    lineInbox: [],
    groupBuyStock: {},
    inventoryMovements: [],
    activeGroupBuyId: "" // 當前選取的團購活動 ID
};
let pendingExcelOrderImport = null;

// --- 舊版內建範例資料簽名（僅供一次性清除比對，不再載入為初始資料） ---
const DEMO_LEGACY = {
    groupBuys: [
        { id: "GB001", name: "2026年7月盛夏消暑團", startDate: "2026-07-01", endDate: "2026-07-20", status: "開放", notes: "本團主打古早味手工蛋捲與清涼飲品！" },
        { id: "GB002", name: "2026年6月端午佳節團", startDate: "2026-06-01", endDate: "2026-06-18", status: "完成", notes: "端午伴手禮，出貨完畢。" }
    ],
    products: [
        { id: "P001", name: "手工古早味蛋捲", specs: "原味 / 12入", price: 180, unit: "盒", photo: "", enabled: true },
        { id: "P002", name: "手工古早味蛋捲", specs: "芝麻 / 12入", price: 190, unit: "盒", photo: "", enabled: true },
        { id: "P003", name: "手作韭菜水餃", specs: "30顆裝", price: 150, unit: "包", photo: "", enabled: true },
        { id: "P004", name: "手作高麗菜水餃", specs: "30顆裝", price: 150, unit: "包", photo: "", enabled: true },
        { id: "P005", name: "阿賢特調冰紅茶", specs: "微糖 / 1000ml", price: 60, unit: "瓶", photo: "", enabled: true },
        { id: "P006", name: "鮮奶吐司", specs: "原味 / 厚片4片", price: 80, unit: "包", photo: "", enabled: true }
    ],
    customers: [
        { id: "A001", nickname: "陳小明", phone: "0912-345-678", address: "台北市信義區信義路五段7號", notes: "常買紅茶，通常自取" },
        { id: "A002", nickname: "林美玲", phone: "0928 765 432", address: "新北市板橋區縣民大道二段3號", notes: "外送常客，住大樓有管理室" },
        { id: "A003", nickname: "張志豪", phone: "(02)2712-3456", address: "台北市大安區新生南路三段1號", notes: "通常自取，韭菜水餃不加蒜" },
        { id: "A004", nickname: "王小華", phone: "0933-111-222", address: "台北市中山區南京東路三段200號", notes: "蛋捲愛好者" },
        { id: "A005", nickname: "許美淑", phone: "0988 555 666", address: "", notes: "固定自取" },
        { id: "A006", nickname: "李大同", phone: "0910-999-888", address: "新北市三重區重新路四段10號", notes: "外送需在晚上6點後" },
        { id: "A007", nickname: "黃阿姨", phone: "0955-444-333", address: "台北市松山區民生東路五段100號", notes: "訂購量較大，會核對商品" },
        { id: "A008", nickname: "趙叔叔", phone: "0937-222-333", address: "台北市內湖區成功路四段50號", notes: "外送，付款乾脆" }
    ],
    orders: [
        {
            id: "ORD00001",
            groupBuyId: "GB001",
            customerId: "A001",
            customerNickname: "陳小明",
            phone: "0912-345-678",
            address: "台北市信義區信義路五段7號",
            pickupType: "自取",
            items: [
                { productId: "P001", productName: "手工古早味蛋捲", specs: "原味 / 12入", quantity: 2, price: 180 },
                { productId: "P005", productName: "阿賢特調冰紅茶", specs: "微糖 / 1000ml", quantity: 3, price: 60 }
            ],
            totalAmount: 540,
            paymentStatus: "已付款",
            orderStatus: "已包貨",
            notes: "自取時間：週六下午",
            createdDate: "2026-07-02 10:15:30",
            checkedProductIds: ["P001", "P005"]
        },
        {
            id: "ORD00002",
            groupBuyId: "GB001",
            customerId: "A002",
            customerNickname: "林美玲",
            phone: "0928 765 432",
            address: "新北市板橋區縣民大道二段3號",
            pickupType: "外送",
            items: [
                { productId: "P003", productName: "手作韭菜水餃", specs: "30顆裝", quantity: 1, price: 150 },
                { productId: "P004", productName: "手作高麗菜水餃", specs: "30顆裝", quantity: 2, price: 150 }
            ],
            totalAmount: 450,
            paymentStatus: "未付款",
            orderStatus: "已確認",
            notes: "放管理室即可",
            createdDate: "2026-07-03 14:22:10",
            checkedProductIds: []
        },
        {
            id: "ORD00003",
            groupBuyId: "GB001",
            customerId: "A003",
            customerNickname: "張志豪",
            phone: "(02)2712-3456",
            address: "台北市大安區新生南路三段1號",
            pickupType: "自取",
            items: [
                { productId: "P001", productName: "手工古早味蛋捲", specs: "原味 / 12入", quantity: 1, price: 180 },
                { productId: "P002", productName: "手工古早味蛋捲", specs: "芝麻 / 12入", quantity: 1, price: 190 },
                { productId: "P005", productName: "阿賢特調冰紅茶", specs: "微糖 / 1000ml", quantity: 2, price: 60 }
            ],
            totalAmount: 490,
            paymentStatus: "已付款",
            orderStatus: "新訂單",
            notes: "",
            createdDate: "2026-07-04 09:30:15",
            checkedProductIds: ["P001"]
        },
        {
            id: "ORD00004",
            groupBuyId: "GB001",
            customerId: "A004",
            customerNickname: "王小華",
            phone: "0933-111-222",
            address: "台北市中山區南京東路三段200號",
            pickupType: "外送",
            items: [
                { productId: "P006", productName: "鮮奶吐司", specs: "原味 / 厚片4片", quantity: 3, price: 80 }
            ],
            totalAmount: 240,
            paymentStatus: "已付款",
            orderStatus: "已包貨",
            notes: "",
            createdDate: "2026-07-05 16:45:00",
            checkedProductIds: ["P006"]
        },
        {
            id: "ORD00005",
            groupBuyId: "GB001",
            customerId: "A005",
            customerNickname: "許美淑",
            phone: "0988 555 666",
            address: "",
            pickupType: "自取",
            items: [
                { productId: "P002", productName: "手工古早味蛋捲", specs: "芝麻 / 12入", quantity: 2, price: 190 },
                { productId: "P005", productName: "阿賢特調冰紅茶", specs: "微糖 / 1000ml", quantity: 4, price: 60 }
            ],
            totalAmount: 620,
            paymentStatus: "未付款",
            orderStatus: "新訂單",
            notes: "",
            createdDate: "2026-07-06 11:10:05",
            checkedProductIds: []
        },
        {
            id: "ORD00006",
            groupBuyId: "GB001",
            customerId: "A006",
            customerNickname: "李大同",
            phone: "0910-999-888",
            address: "新北市三重區重新路四段10號",
            pickupType: "外送",
            items: [
                { productId: "P004", productName: "手作高麗菜水餃", specs: "30顆裝", quantity: 2, price: 150 },
                { productId: "P006", productName: "鮮奶吐司", specs: "原味 / 厚片4片", quantity: 1, price: 80 }
            ],
            totalAmount: 380,
            paymentStatus: "已付款",
            orderStatus: "已完成",
            notes: "請晚上6點後送來",
            createdDate: "2026-07-07 18:20:00",
            checkedProductIds: ["P004", "P006"]
        },
        {
            id: "ORD00007",
            groupBuyId: "GB001",
            customerId: "A007",
            customerNickname: "黃阿姨",
            phone: "0955-444-333",
            address: "台北市松山區民生東路五段100號",
            pickupType: "外送",
            items: [
                { productId: "P001", productName: "手工古早味蛋捲", specs: "原味 / 12入", quantity: 3, price: 180 },
                { productId: "P002", productName: "手工古早味蛋捲", specs: "芝麻 / 12入", quantity: 2, price: 190 },
                { productId: "P003", productName: "手作韭菜水餃", specs: "30顆裝", quantity: 2, price: 150 },
                { productId: "P004", productName: "手作高麗菜水餃", specs: "30顆裝", quantity: 2, price: 150 }
            ],
            totalAmount: 1520,
            paymentStatus: "未付款",
            orderStatus: "已確認",
            notes: "",
            createdDate: "2026-07-08 15:40:12",
            checkedProductIds: []
        },
        {
            id: "ORD00008",
            groupBuyId: "GB001",
            customerId: "A008",
            customerNickname: "趙叔叔",
            phone: "0937-222-333",
            address: "台北市內湖區成功路四段50號",
            pickupType: "外送",
            items: [
                { productId: "P005", productName: "阿賢特調冰紅茶", specs: "微糖 / 1000ml", quantity: 5, price: 60 }
            ],
            totalAmount: 300,
            paymentStatus: "已付款",
            orderStatus: "新訂單",
            notes: "",
            createdDate: "2026-07-09 13:12:45",
            checkedProductIds: []
        },
        {
            id: "ORD00009",
            groupBuyId: "GB002",
            customerId: "A001",
            customerNickname: "陳小明",
            phone: "0912-345-678",
            address: "台北市信義區信義路五段7號",
            pickupType: "自取",
            items: [
                { productId: "P001", productName: "手工古早味蛋捲", specs: "原味 / 12入", quantity: 2, price: 180 },
                { productId: "P005", productName: "阿賢特調冰紅茶", specs: "微糖 / 1000ml", quantity: 2, price: 60 }
            ],
            totalAmount: 480,
            paymentStatus: "已付款",
            orderStatus: "已完成",
            notes: "",
            createdDate: "2026-06-05 10:00:00",
            checkedProductIds: ["P001", "P005"]
        },
        {
            id: "ORD00010",
            groupBuyId: "GB002",
            customerId: "A002",
            customerNickname: "林美玲",
            phone: "0928 765 432",
            address: "新北市板橋區縣民大道二段3號",
            pickupType: "外送",
            items: [
                { productId: "P003", productName: "手作韭菜水餃", specs: "30顆裝", quantity: 2, price: 150 },
                { productId: "P004", productName: "手作高麗菜水餃", specs: "30顆裝", quantity: 2, price: 150 }
            ],
            totalAmount: 600,
            paymentStatus: "已付款",
            orderStatus: "已完成",
            notes: "",
            createdDate: "2026-06-06 15:00:00",
            checkedProductIds: ["P003", "P004"]
        }
    ]
};

// --- 初始化載入 ---
window.onload = function() {
    initDatabase();
    renderCurrentGroupBuySelect();
    switchView('dashboard');
    initializeProductVoiceSupport();
};

window.addEventListener('beforeunload', () => stopProductVoiceRecognition('已停止錄音'));

// 初始化資料庫 (若 LocalStorage 無資料則載入示範資料)
function initDatabase() {
    const localGB = localStorage.getItem("easygo_groupbuys");
    const localProd = localStorage.getItem("easygo_products");
    const localCust = localStorage.getItem("easygo_customers");
    const localOrd = localStorage.getItem("easygo_orders");
    const localActiveId = localStorage.getItem("easygo_active_gb_id");

    if (localGB && localProd && localCust && localOrd) {
        state.groupBuys = JSON.parse(localGB);
        state.products = JSON.parse(localProd);
        state.customers = JSON.parse(localCust);
        state.orders = JSON.parse(localOrd);
        state.activeGroupBuyId = localActiveId || (state.groupBuys[0] ? state.groupBuys[0].id : "");
        purgeDemoData();
    } else {
        // 全新環境：以空資料啟動（不再載入範例資料）
        state.groupBuys = [];
        state.products = [];
        state.customers = [];
        state.orders = [];
        state.activeGroupBuyId = "";
        saveStateToStorage();
    }
}

// 一次性清除舊版內建範例資料（比對編號＋內容，避免誤刪使用者自建資料）
function purgeDemoData() {
    const demoProducts = new Set(DEMO_LEGACY.products.map(p => `${p.id}|${p.name}`));
    const demoCustomers = new Set(DEMO_LEGACY.customers.map(c => `${c.id}|${c.nickname}`));
    // 訂單不可只比對 ID：真實訂單編號同樣從 ORD00001 起跳，純 ID 會誤刪使用者的真訂單。
    // 必須「ID＋客戶＋金額＋建立日」全部吻合才視為範例訂單（2026-07-21 驗收修正）。
    const demoOrders = new Map(DEMO_LEGACY.orders.map(o => [o.id, o]));
    const isDemoOrder = (o) => {
        const d = demoOrders.get(o.id);
        return Boolean(d && d.customerId === o.customerId && d.totalAmount === o.totalAmount && d.createdDate === o.createdDate);
    };
    const demoGroupBuys = new Set(DEMO_LEGACY.groupBuys.map(g => `${g.id}|${g.name}`));

    const productsBeforePurge = state.products;
    const before = state.products.length + state.customers.length + state.orders.length + state.groupBuys.length;
    state.orders = state.orders.filter(o => !isDemoOrder(o));
    // 清完範例訂單後，仍被「剩餘真實訂單」引用的商品/客戶/團購一律保留（避免孤兒引用）
    const usedProductIds = new Set(state.orders.flatMap(o => (o.items || []).map(it => it.productId)));
    const usedCustomerIds = new Set(state.orders.map(o => o.customerId));
    const usedGroupBuyIds = new Set(state.orders.map(o => o.groupBuyId));
    state.products = state.products.filter(p => !(demoProducts.has(`${p.id}|${p.name}`) && !usedProductIds.has(p.id)));
    state.customers = state.customers.filter(c => !(demoCustomers.has(`${c.id}|${c.nickname}`) && !usedCustomerIds.has(c.id)));
    state.groupBuys = state.groupBuys.filter(g => !(demoGroupBuys.has(`${g.id}|${g.name}`) && !usedGroupBuyIds.has(g.id)));
    // 只對「實際被移除」的商品做雲端清除，保留下來的不能誤刪雲端資料
    const keptProductIds = new Set(state.products.map(p => p.id));
    const removedProducts = productsBeforePurge.filter(p => demoProducts.has(`${p.id}|${p.name}`) && !keptProductIds.has(p.id));
    const removed = before - (state.products.length + state.customers.length + state.orders.length + state.groupBuys.length);

    if (removed > 0) {
        if (!state.groupBuys.some(g => g.id === state.activeGroupBuyId)) {
            state.activeGroupBuyId = state.groupBuys[0] ? state.groupBuys[0].id : "";
        }
        saveStateToStorage();
        // 若範例商品先前曾同步到雲端，一併清除（背景執行，失敗不影響本機）
        removedProducts.forEach(p => { deleteProductFromCloud(p.id); });
        console.info(`已清除 ${removed} 筆內建範例資料`);
    }
}

// 儲存狀態至 LocalStorage
function saveStateToStorage() {
    localStorage.setItem("easygo_groupbuys", JSON.stringify(state.groupBuys));
    localStorage.setItem("easygo_products", JSON.stringify(state.products));
    localStorage.setItem("easygo_customers", JSON.stringify(state.customers));
    localStorage.setItem("easygo_orders", JSON.stringify(state.orders));
    localStorage.setItem("easygo_active_gb_id", state.activeGroupBuyId);
}

// --- 視圖切換邏輯 (SPA Routing) ---
let currentViewId = 'dashboard';
function switchView(viewId, subviewAction = '') {
    currentViewId = viewId;
    
    // 隱藏所有視圖 section
    document.querySelectorAll('.view-section').forEach(section => {
        section.style.display = 'none';
    });
    
    // 顯示目標視圖
    const targetSection = document.getElementById(`${viewId}-view`);
    if (targetSection) {
        targetSection.style.display = 'block';
    }
    
    // 更新導覽列選單 Active 狀態
    document.querySelectorAll('.sidebar-menu .menu-item').forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('data-view') === viewId) {
            item.classList.add('active');
        }
    });

    // 關閉手機版側邊選單
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('show');

    // 根據不同頁面載入特定資料
    if (viewId === 'dashboard') {
        renderDashboard();
        loadGroupBuyStock(state.activeGroupBuyId).then(() => {
            if (currentViewId === 'dashboard') renderDashboard();
        });
    } else if (viewId === 'group-buys') {
        renderGroupBuys();
        loadGroupBuyStock(state.activeGroupBuyId).then(() => {
            if (currentViewId === 'group-buys') renderGroupBuys();
        });
    } else if (viewId === 'line-inbox') {
        loadLineInbox();
    } else if (viewId === 'line-settings') {
        renderLineSettings();
    } else if (viewId === 'orders') {
        const renderOrdersSubview = () => {
            if (subviewAction === 'by-customer') {
                toggleOrderViewMode('by-customer');
            } else if (subviewAction === 'by-product') {
                toggleOrderViewMode('by-product');
            } else {
                toggleOrderViewMode('list');
            }
        };
        renderOrdersSubview();
        // 背景同步 LINE 靜默收單訂單後重新渲染（失敗不影響本地資料顯示）
        syncLineOrdersFromCloud().then(result => {
            if (result && result.data && result.data.synced && currentViewId === 'orders') renderOrdersSubview();
        });
        loadGroupBuyStock(state.activeGroupBuyId).then(() => {
            if (currentViewId === 'orders') renderOrdersSubview();
        });
    } else if (viewId === 'customers') {
        renderCustomers();
        // 背景把雲端客戶（含 LINE 自動建立、團主自訂名稱）同步回本機後重新渲染
        syncCustomersFromCloud().then(result => {
            if (result && result.data && result.data.synced && currentViewId === 'customers') renderCustomers();
        });
    } else if (viewId === 'products') {
        renderProducts();
        loadGroupBuyStock(state.activeGroupBuyId).then(() => {
            if (currentViewId === 'products') renderProducts();
        });
    } else if (viewId === 'excel') {
        prepareExcelExport();
        // 匯出前先把 LINE 靜默收單訂單同步回本機，避免 Excel 少單
        syncLineOrdersFromCloud();
        loadGroupBuyStock(state.activeGroupBuyId);
        loadInventoryMovements(state.activeGroupBuyId);
    }
    
    window.scrollTo(0, 0);
}

// 手機版側邊選單開關
function toggleMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.toggle('show');
}

// 當前團購活動切換
function onGroupBuyChange(val) {
    state.activeGroupBuyId = val;
    saveStateToStorage();
    // 重新載入當前視圖資料
    switchView(currentViewId);
}

// 渲染頂部活動選擇器
function renderCurrentGroupBuySelect() {
    const select = document.getElementById('currentGroupBuySelect');
    const selectExport = document.getElementById('export-group-select');
    const selectImport = document.getElementById('excel-import-group-select');
    
    let html = "";
    // 依狀態排序：開放 -> 截止 -> 完成
    const sortedGB = [...state.groupBuys].sort((a, b) => {
        const order = { "開放": 1, "截止": 2, "完成": 3 };
        return order[a.status] - order[b.status];
    });

    sortedGB.forEach(gb => {
        const isSelected = gb.id === state.activeGroupBuyId ? "selected" : "";
        html += `<option value="${escapeHtml(gb.id)}" ${isSelected}>[${gb.status}] ${escapeHtml(gb.name)}</option>`;
    });

    if (select) select.innerHTML = html;
    if (selectExport) selectExport.innerHTML = html;
    if (selectImport) selectImport.innerHTML = html;
}


// ==========================================================================
// 1. 首頁 (Dashboard) 邏輯
// ==========================================================================
function renderDashboard() {
    const activeGb = state.groupBuys.find(g => g.id === state.activeGroupBuyId);
    const title = document.getElementById('dashboard-title');
    if (title) {
        title.innerHTML = activeGb 
            ? `${escapeHtml(activeGb.name)} <span class="badge ${activeGb.status === '開放' ? 'badge-group-open' : activeGb.status === '截止' ? 'badge-group-closed' : 'badge-group-completed'}">${activeGb.status}</span>`
            : "尚未選擇/建立團購活動";
    }

    // 篩選出當前活動的訂單 (排除已取消)
    const activeOrders = state.orders.filter(o => o.groupBuyId === state.activeGroupBuyId && o.orderStatus !== "已取消");
    const allActiveOrdersWithCancel = state.orders.filter(o => o.groupBuyId === state.activeGroupBuyId);

    // 統計卡片資料
    // 客戶總數 (依 customerId 去重)
    const customerIds = new Set(activeOrders.map(o => o.customerId));
    document.getElementById('stat-customers').textContent = customerIds.size;

    // 訂單總金額
    const totalAmount = activeOrders.reduce((sum, o) => sum + o.totalAmount, 0);
    document.getElementById('stat-amount').textContent = `NT$ ${totalAmount.toLocaleString()}`;

    // 未付款數 (付款狀態為未付款的訂單數)
    const unpaidCount = activeOrders.filter(o => o.paymentStatus === "未付款").length;
    document.getElementById('stat-unpaid').textContent = unpaidCount;

    // 未包貨客戶數 (訂單狀態為 新訂單、已確認 且尚未勾選完包貨的客戶數)
    // 這裡我們直接看訂單狀態不是 "已包貨"、"已完成"、"已取消" 的訂單數
    const unpackedCount = activeOrders.filter(o => o.orderStatus === "新訂單" || o.orderStatus === "已確認").length;
    document.getElementById('stat-unpacked').textContent = unpackedCount;

    // 外送單數
    const deliveryCount = activeOrders.filter(o => o.pickupType === "外送").length;
    document.getElementById('stat-delivery').textContent = deliveryCount;

    // 自取單數
    const pickupCount = activeOrders.filter(o => o.pickupType === "自取").length;
    document.getElementById('stat-pickup').textContent = pickupCount;

    const activeStocks = Object.values(state.groupBuyStock)
        .filter(stock => stock.groupBuyId === state.activeGroupBuyId && stock.stockEnabled);
    const lowStocks = activeStocks.filter(stock => stock.stockStatus === 'low_stock');
    const soldOutStocks = activeStocks.filter(stock => stock.stockStatus === 'sold_out');
    document.getElementById('dashboard-low-stock-count').textContent = `${lowStocks.length} 項`;
    document.getElementById('dashboard-sold-out-count').textContent = `${soldOutStocks.length} 項`;
    const stockRows = rows => rows.map(stock => `<div class="inventory-alert-item">
        <strong>${escapeHtml(stock.productCode)}</strong>｜${escapeHtml(stock.productName)}｜剩餘 ${stock.remainingQuantity} ${escapeHtml(stock.unit || '份')}
    </div>`).join('');
    document.getElementById('dashboard-low-stock-list').innerHTML = stockRows(lowStocks) || '目前沒有即將售完商品';
    document.getElementById('dashboard-sold-out-list').innerHTML = stockRows(soldOutStocks) || '目前沒有售完商品';

    // 首頁表格：尚未完成訂單 (新訂單、已確認、已包貨) - 限前 10 筆
    const incompleteOrders = allActiveOrdersWithCancel
        .filter(o => ["新訂單", "已確認", "已包貨"].includes(o.orderStatus))
        .sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate))
        .slice(0, 10);
        
    document.getElementById('home-incomplete-count').textContent = `${allActiveOrdersWithCancel.filter(o => ["新訂單", "已確認", "已包貨"].includes(o.orderStatus)).length} 筆`;

    let incompleteHtml = "";
    incompleteOrders.forEach(o => {
        incompleteHtml += `
            <tr>
                <td><a onclick="viewOrderDetail('${o.id}')" style="color: var(--primary-orange); cursor:pointer; font-weight:700;">${o.id}</a></td>
                <td><span class="badge badge-id" style="margin-right:6px;">${escapeHtml(o.customerId)}</span>${escapeHtml(orderCustomerName(o))}</td>
                <td><span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span></td>
                <td style="font-weight:700;">NT$ ${o.totalAmount}</td>
                <td><span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span></td>
                <td><span class="badge badge-status-${getStatusClass(o.orderStatus)}">${o.orderStatus}</span></td>
            </tr>
        `;
    });
    document.getElementById('home-incomplete-orders-tbody').innerHTML = incompleteHtml || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">無尚未完成訂單</td></tr>`;

    // 首頁表格：最近新增訂單 (前 10 筆)
    const recentOrders = allActiveOrdersWithCancel
        .sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate))
        .slice(0, 10);

    let recentHtml = "";
    recentOrders.forEach(o => {
        recentHtml += `
            <tr>
                <td><a onclick="viewOrderDetail('${o.id}')" style="color: var(--primary-orange); cursor:pointer; font-weight:700;">${o.id}</a></td>
                <td><span class="badge badge-id" style="margin-right:6px;">${escapeHtml(o.customerId)}</span>${escapeHtml(orderCustomerName(o))}</td>
                <td><span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span></td>
                <td style="font-weight:700;">NT$ ${o.totalAmount}</td>
                <td><span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span></td>
                <td><span class="badge badge-status-${getStatusClass(o.orderStatus)}">${o.orderStatus}</span></td>
            </tr>
        `;
    });
    document.getElementById('home-recent-orders-tbody').innerHTML = recentHtml || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">本團尚無訂單</td></tr>`;
}

function getStatusClass(status) {
    switch (status) {
        case "新訂單": return "new";
        case "已確認": return "confirmed";
        case "已包貨": return "packed";
        case "已完成": return "completed";
        case "已取消": return "cancelled";
        default: return "new";
    }
}


// ==========================================================================
// 2. 團購活動 (Group Buy) 邏輯
// ==========================================================================
function renderGroupBuys() {
    const tbody = document.getElementById('group-buys-tbody');
    let html = "";

    // 依建立先後反向排序
    const sorted = [...state.groupBuys].reverse();

    sorted.forEach(gb => {
        const isCurrent = gb.id === state.activeGroupBuyId ? `<i class="fa-solid fa-star text-orange" title="當前選定活動"></i> ` : "";
        html += `
            <tr style="${gb.id === state.activeGroupBuyId ? 'background-color: rgba(255, 122, 0, 0.03);' : ''}">
                <td style="font-weight:700;">${isCurrent}${escapeHtml(gb.name)}</td>
                <td style="font-family: Outfit;">${gb.startDate || '-'}</td>
                <td style="font-family: Outfit;">${gb.endDate || '-'}</td>
                <td><span class="badge ${gb.status === '開放' ? 'badge-group-open' : gb.status === '截止' ? 'badge-group-closed' : 'badge-group-completed'}">${gb.status}</span></td>
                <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(gb.notes || '')}</td>
                <td>
                    <div class="button-group">
                        <button class="btn btn-secondary btn-sm" onclick="openGroupBuyModal('${gb.id}')"><i class="fa-solid fa-edit"></i> 編輯</button>
                        ${gb.id === state.activeGroupBuyId
                            ? '<button class="btn btn-primary btn-sm" disabled style="opacity:1; cursor:default;"><i class="fa-solid fa-circle-check"></i> 目前團購</button>'
                            : `<button class="btn btn-secondary btn-sm" onclick="selectGroupBuyDirectly('${gb.id}')"><i class="fa-solid fa-circle-check"></i> 選定</button>`}
                        <button class="btn btn-teal btn-sm" onclick="copyProductsFromPreviousGroup('${gb.id}')" title="複製前一團的商品列表"><i class="fa-solid fa-copy"></i> 複製前團商品</button>
                        <button class="btn btn-secondary btn-sm" onclick="openStockReconcileModal('${gb.id}')"><i class="fa-solid fa-scale-balanced"></i> 核對庫存</button>
                        <button class="btn btn-primary btn-sm" onclick="openLinePublishModal('${gb.id}')"><i class="fa-brands fa-line"></i> 發布到 LINE 群組</button>
                    </div>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">尚無團購活動資料</td></tr>`;
}

function selectGroupBuyDirectly(id) {
    onGroupBuyChange(id);
    renderCurrentGroupBuySelect();
    renderGroupBuys(); // 立即更新「目前團購」按鈕狀態
    const gb = state.groupBuys.find(g => g.id === id);
    alert(`已切換目前團購為：${gb ? gb.name : id}`);
}

function copyProductsFromPreviousGroup(targetGroupId) {
    // 找出目前所有活動中，時間早於 targetGroupId 的前一個活動，
    // 但因為我們是純前端暫存，直接找 groupBuys 陣列中 targetGroupId 索引之前的那個活動
    const targetIdx = state.groupBuys.findIndex(g => g.id === targetGroupId);
    if (targetIdx <= 0) {
        alert("此活動為第一個活動，無法複製前一團商品！");
        return;
    }
    
    const prevGroup = state.groupBuys[targetIdx - 1];
    if (confirm(`確定要從「${prevGroup.name}」複製商品清單到當前活動中嗎？\n(這會將所有啟用商品啟用狀態維持在當前商品庫中)`)) {
        // 本系統商品為全局共享，並設有「啟用/停用」狀態。
        // 所謂「複製上一團商品」，在全局商品庫中指：確認上一團已啟用的商品，在這一團也維持啟用，
        // 同時在此做一次全局商品的狀態檢查。我們提示使用者複製完成。
        alert(`已成功複製「${prevGroup.name}」的商品設定！(目前共 ${state.products.filter(p=>p.enabled).length} 個啟用商品)`);
    }
}

// 團購活動 Modal 控制
// 團購商品勾選清單（記事本文案與 LINE 商品卡只列本團商品）
function renderGroupBuyProductChecklist(selectedIds = [], groupBuyId = '') {
    const container = document.getElementById('gb-products');
    if (!container) return;
    if (!state.products.length) {
        container.innerHTML = '<small class="text-muted">尚無商品，請先到「商品管理」新增。</small>';
        return;
    }
    const selected = new Set(selectedIds);
    const rows = [...state.products]
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
        .map(p => {
            const stock = stockFor(groupBuyId, p.id) || {
                stockEnabled: false,
                incomingQuantity: 0,
                reservedQuantity: 0,
                sellableQuantity: 0,
                soldQuantity: 0,
                remainingQuantity: 0,
                lowStockThreshold: 5,
                stockStatus: 'in_stock'
            };
            const checked = selected.has(p.id);
            return `<tr class="gb-stock-row" data-product-id="${escapeHtml(p.id)}">
                <td><input type="checkbox" class="gb-product-checkbox" value="${escapeHtml(p.id)}"
                    ${checked ? 'checked' : ''} onchange="toggleGroupBuyStockRow('${escapeHtml(p.id)}')"></td>
                <td><strong>${escapeHtml(p.id)}</strong><br><small>${escapeHtml(p.name)}${p.enabled ? '' : '（已停用）'}</small></td>
                <td><input type="checkbox" class="gb-stock-enabled" ${stock.stockEnabled ? 'checked' : ''}
                    ${checked ? '' : 'disabled'} onchange="updateGroupBuyStockPreview('${escapeHtml(p.id)}')"></td>
                <td><input type="number" class="form-control gb-stock-incoming" min="0" value="${stock.incomingQuantity}"
                    ${checked ? '' : 'disabled'} oninput="updateGroupBuyStockPreview('${escapeHtml(p.id)}')"></td>
                <td><input type="number" class="form-control gb-stock-reserved" min="0" value="${stock.reservedQuantity}"
                    ${checked ? '' : 'disabled'} oninput="updateGroupBuyStockPreview('${escapeHtml(p.id)}')"></td>
                <td class="gb-stock-sellable">${stock.sellableQuantity}</td>
                <td class="gb-stock-sold">${stock.soldQuantity}</td>
                <td class="gb-stock-remaining">${stock.remainingQuantity}</td>
                <td><input type="number" class="form-control gb-stock-threshold" min="0" value="${stock.lowStockThreshold}"
                    ${checked ? '' : 'disabled'} oninput="updateGroupBuyStockPreview('${escapeHtml(p.id)}')"></td>
                <td class="gb-stock-status">${stockStatusBadge(stock)}</td>
                <td>${groupBuyId && stock.stockEnabled
                    ? `<button type="button" class="btn btn-secondary btn-sm" onclick="openStockAdjustModal('${escapeHtml(groupBuyId)}','${escapeHtml(p.id)}')">調整庫存</button>`
                    : '-'}</td>
            </tr>`;
        }).join('');
    container.innerHTML = `<div class="table-responsive"><table class="table-custom stock-config-table">
        <thead><tr><th>加入</th><th>商品</th><th>限量</th><th>進貨</th><th>保留</th><th>可賣</th><th>已售</th><th>剩餘</th><th>低庫存</th><th>狀態</th><th>調整</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

function groupBuyStockRow(productId) {
    return [...document.querySelectorAll('.gb-stock-row')].find(row => row.dataset.productId === productId);
}

function toggleGroupBuyStockRow(productId) {
    const row = groupBuyStockRow(productId);
    if (!row) return;
    const checked = row.querySelector('.gb-product-checkbox').checked;
    row.querySelectorAll('input:not(.gb-product-checkbox)').forEach(input => { input.disabled = !checked; });
    updateGroupBuyStockPreview(productId);
}

function updateGroupBuyStockPreview(productId) {
    const row = groupBuyStockRow(productId);
    if (!row) return;
    const enabled = row.querySelector('.gb-stock-enabled').checked;
    const incoming = Math.max(0, Number(row.querySelector('.gb-stock-incoming').value) || 0);
    const reserved = Math.max(0, Number(row.querySelector('.gb-stock-reserved').value) || 0);
    const sold = Math.max(0, Number(row.querySelector('.gb-stock-sold').textContent) || 0);
    const threshold = Math.max(0, Number(row.querySelector('.gb-stock-threshold').value) || 0);
    const sellable = Math.max(0, incoming - reserved);
    const remaining = Math.max(0, sellable - sold);
    row.querySelector('.gb-stock-sellable').textContent = sellable;
    row.querySelector('.gb-stock-remaining').textContent = remaining;
    row.querySelector('.gb-stock-status').innerHTML = stockStatusBadge({
        stockEnabled: enabled,
        remainingQuantity: remaining,
        lowStockThreshold: threshold,
        stockStatus: !enabled ? 'in_stock' : remaining <= 0 ? 'sold_out' : remaining <= threshold ? 'low_stock' : 'in_stock'
    });
}

function collectGroupBuyStockSettings() {
    return [...document.querySelectorAll('.gb-stock-row')]
        .filter(row => row.querySelector('.gb-product-checkbox').checked)
        .map(row => ({
            productId: row.dataset.productId,
            stockEnabled: row.querySelector('.gb-stock-enabled').checked,
            incomingQuantity: Math.max(0, Number(row.querySelector('.gb-stock-incoming').value) || 0),
            reservedQuantity: Math.max(0, Number(row.querySelector('.gb-stock-reserved').value) || 0),
            lowStockThreshold: Math.max(0, Number(row.querySelector('.gb-stock-threshold').value) || 0)
        }));
}

// 取得團購綁定的商品；未勾選（舊資料）則回傳所有商品（維持原行為）
function groupBuyProducts(gb) {
    const ids = gb && Array.isArray(gb.productIds) ? gb.productIds : [];
    if (!ids.length) return state.products;
    return state.products.filter(p => ids.includes(p.id));
}

async function openGroupBuyModal(id = '') {
    const modal = document.getElementById('group-buy-modal');
    const title = document.getElementById('group-buy-modal-title');
    const form = document.getElementById('group-buy-form');

    form.reset();
    document.getElementById('group-buy-id').value = id;

    if (id) {
        title.textContent = "編輯團購活動";
        const gb = state.groupBuys.find(g => g.id === id);
        if (gb) {
            document.getElementById('gb-name').value = gb.name;
            document.getElementById('gb-start-date').value = gb.startDate;
            document.getElementById('gb-end-date').value = gb.endDate;
            document.getElementById('gb-status').value = gb.status;
            document.getElementById('gb-notes').value = gb.notes;
            renderGroupBuyProductChecklist(gb.productIds || [], id);
            await loadGroupBuyStock(id);
            renderGroupBuyProductChecklist(gb.productIds || [], id);
        }
    } else {
        title.textContent = "新增團購活動";
        document.getElementById('gb-status').value = "開放";
        document.getElementById('gb-start-date').value = new Date().toISOString().split('T')[0];
        renderGroupBuyProductChecklist([]);
    }
    modal.classList.add('show');
}

function closeGroupBuyModal() {
    document.getElementById('group-buy-modal').classList.remove('show');
}

async function saveGroupBuy() {
    const id = document.getElementById('group-buy-id').value;
    const name = document.getElementById('gb-name').value.trim();
    const startDate = document.getElementById('gb-start-date').value;
    const endDate = document.getElementById('gb-end-date').value;
    const status = document.getElementById('gb-status').value;
    const notes = document.getElementById('gb-notes').value.trim();
    const productIds = [...document.querySelectorAll('.gb-product-checkbox:checked')].map(input => input.value);
    const stockSettings = collectGroupBuyStockSettings();

    if (!name) {
        alert("請輸入團購活動名稱！");
        return;
    }
    const invalidStock = stockSettings.find(stock => stock.stockEnabled && stock.reservedQuantity > stock.incomingQuantity);
    if (invalidStock) {
        alert(`${invalidStock.productId} 的保留數量不可大於進貨數量。`);
        return;
    }

    let savedGroupBuy;
    if (id) {
        // 編輯
        const gb = state.groupBuys.find(g => g.id === id);
        if (gb) {
            gb.name = name;
            gb.startDate = startDate;
            gb.endDate = endDate;
            gb.status = status;
            gb.notes = notes;
            gb.productIds = productIds;
            gb.stockSettings = stockSettings;
            savedGroupBuy = gb;
        }
    } else {
        // 新增
        // 以現有最大編號+1 產生，避免刪除或匯入後「筆數+1」與既有編號重複（2026-07-22 驗收修正）
        const maxGbNum = state.groupBuys.reduce((max, g) => {
            const match = String(g.id).match(/^GB(\d+)$/i);
            return match ? Math.max(max, parseInt(match[1], 10)) : max;
        }, 0);
        const newId = "GB" + String(maxGbNum + 1).padStart(3, '0');
        savedGroupBuy = { id: newId, name, startDate, endDate, status, notes, productIds, stockSettings };
        state.groupBuys.push(savedGroupBuy);
        if (state.groupBuys.length === 1) {
            state.activeGroupBuyId = newId;
        }
    }

    saveStateToStorage();
    if (getCloudApiKey()) {
        const originalButton = document.querySelector('#group-buy-modal .modal-footer .btn-primary');
        if (originalButton) {
            originalButton.disabled = true;
            originalButton.textContent = '儲存中…';
        }
        try {
            for (const productId of productIds) {
                const product = state.products.find(item => item.id === productId);
                if (!product) continue;
                const productResult = await syncProductToCloud(product);
                if (productResult.error || productResult.skipped) throw new Error(productResult.error || `商品 ${productId} 尚未同步`);
            }
            const groupResult = await cloudFetch(`/api/group-buys/${encodeURIComponent(savedGroupBuy.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    starts_at: groupBuyDateTime(startDate),
                    ends_at: groupBuyDateTime(endDate, true),
                    status: groupBuyStatusForCloud(status),
                    notes: notes || null,
                    product_ids: productIds
                })
            });
            if (groupResult.error || groupResult.skipped) throw new Error(groupResult.error || '團購同步失敗');
            for (const stock of stockSettings) {
                const stockResult = await cloudFetch(`/api/group-buys/${encodeURIComponent(savedGroupBuy.id)}/stock/${encodeURIComponent(stock.productId)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(stock)
                });
                if (stockResult.error || stockResult.skipped) throw new Error(`${stock.productId}：${stockResult.error || '庫存同步失敗'}`);
                state.groupBuyStock[stockKey(savedGroupBuy.id, stock.productId)] = stockResult.data.stock;
            }
        } catch (error) {
            alert(`團購已保存在本機，但雲端庫存同步失敗：${error.message}`);
            if (originalButton) {
                originalButton.disabled = false;
                originalButton.textContent = '儲存活動';
            }
            return;
        }
        if (originalButton) {
            originalButton.disabled = false;
            originalButton.textContent = '儲存活動';
        }
    }
    renderCurrentGroupBuySelect();
    closeGroupBuyModal();
    renderGroupBuys();
    if (currentViewId === 'dashboard') renderDashboard();
}

function openStockAdjustModal(groupBuyId, productId) {
    const stock = stockFor(groupBuyId, productId);
    if (!stock) return alert('請先重新讀取團購庫存。');
    document.getElementById('stock-adjust-group-id').value = groupBuyId;
    document.getElementById('stock-adjust-product-id').value = productId;
    document.getElementById('stock-adjust-product-label').textContent = `${stock.productCode}｜${stock.productName}`;
    document.getElementById('stock-adjust-current').textContent = stock.remainingQuantity;
    document.getElementById('stock-adjust-quantity').value = 0;
    document.getElementById('stock-adjust-reason').value = '';
    updateStockAdjustPreview();
    openModal('stock-adjust-modal');
}

function updateStockAdjustPreview() {
    const current = Number(document.getElementById('stock-adjust-current').textContent) || 0;
    const change = Number(document.getElementById('stock-adjust-quantity').value) || 0;
    document.getElementById('stock-adjust-after').textContent = current + change;
}

async function confirmStockAdjustment() {
    const groupBuyId = document.getElementById('stock-adjust-group-id').value;
    const productId = document.getElementById('stock-adjust-product-id').value;
    const quantityChange = Number(document.getElementById('stock-adjust-quantity').value);
    const reason = document.getElementById('stock-adjust-reason').value.trim();
    if (!Number.isInteger(quantityChange) || quantityChange === 0) return alert('請輸入非 0 的整數調整量。');
    if (!reason) return alert('請填寫調整原因。');
    const result = await cloudFetch(`/api/group-buys/${encodeURIComponent(groupBuyId)}/stock/${encodeURIComponent(productId)}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantityChange, reason })
    });
    if (result.error || result.skipped) return alert(`調整失敗：${result.error || '尚未設定管理金鑰'}`);
    state.groupBuyStock[stockKey(groupBuyId, productId)] = result.data.stock;
    closeModal('stock-adjust-modal');
    if (document.getElementById('group-buy-modal').classList.contains('show')) {
        const gb = state.groupBuys.find(item => item.id === groupBuyId);
        renderGroupBuyProductChecklist(gb?.productIds || [], groupBuyId);
    }
    renderDashboard();
    renderProducts();
    alert('庫存調整完成，異動原因已記錄。');
}

async function openStockReconcileModal(groupBuyId) {
    const result = await cloudFetch(`/api/group-buys/${encodeURIComponent(groupBuyId)}/stock/reconcile`);
    if (result.error || result.skipped) return alert(`核對失敗：${result.error || '尚未設定管理金鑰'}`);
    const rows = result.data.differences || [];
    document.getElementById('stock-reconcile-group-id').value = groupBuyId;
    document.getElementById('stock-reconcile-tbody').innerHTML = rows.map(row => `<tr>
        <td>${escapeHtml(row.productCode)}</td>
        <td>${escapeHtml(row.productName)}</td>
        <td>${row.soldQuantity}</td>
        <td>${row.actualSoldQuantity}</td>
        <td class="${row.difference ? 'text-orange' : ''}">${row.difference > 0 ? '+' : ''}${row.difference}</td>
    </tr>`).join('') || '<tr><td colspan="5">沒有團購商品。</td></tr>';
    document.getElementById('stock-reconcile-confirm').disabled = !rows.some(row => row.stockEnabled && row.difference !== 0);
    openModal('stock-reconcile-modal');
}

async function confirmStockReconciliation() {
    const groupBuyId = document.getElementById('stock-reconcile-group-id').value;
    if (!confirm('確定依正式有效訂單修正庫存差異？每筆修正都會寫入異動紀錄。')) return;
    const result = await cloudFetch(`/api/group-buys/${encodeURIComponent(groupBuyId)}/stock/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, reason: '後台重新核對庫存' })
    });
    if (result.error || result.skipped) return alert(`修正失敗：${result.error || '尚未設定管理金鑰'}`);
    (result.data.stocks || []).forEach(stock => {
        state.groupBuyStock[stockKey(groupBuyId, stock.productId)] = stock;
    });
    closeModal('stock-reconcile-modal');
    renderDashboard();
    renderProducts();
    alert(`庫存核對完成，共修正 ${result.data.corrected} 項。`);
}

function groupBuyStatusForCloud(status) {
    return status === '開放' ? 'open' : status === '截止' ? 'closed' : 'completed';
}

function groupBuyDateTime(date, endOfDay = false) {
    if (!date) return null;
    return new Date(`${date}T${endOfDay ? '23:59:59' : '00:00:00'}+08:00`).toISOString();
}

function selectedLinePublishQuantities() {
    return [...document.querySelectorAll('.line-publish-quantity:checked')].map(input => Number(input.value));
}

async function openLinePublishModal(groupBuyId) {
    const groupBuy = state.groupBuys.find(item => item.id === groupBuyId);
    if (!groupBuy) return alert('找不到團購活動。');
    if (!groupBuy.endDate) return alert('請先設定團購截止日期，才能發布 LINE 商品卡。');
    const products = groupBuyProducts(groupBuy).filter(product => product.enabled);
    if (!products.length) return alert('本團購沒有啟用中的商品（請在團購活動勾選商品，或啟用商品）。');
    if (!getCloudApiKey()) return alert('請先到「LINE 靜默收單設定」輸入管理 API 金鑰。');

    document.getElementById('line-publish-group-buy-id').value = groupBuyId;
    document.getElementById('line-publish-product').innerHTML = products.map(product =>
        `<option value="${escapeLineText(product.id)}">${escapeLineText(product.id)}｜${escapeLineText(product.name)}｜NT$ ${Number(product.price).toLocaleString()}</option>`
    ).join('');
    document.getElementById('line-publish-group').innerHTML = '<option value="">讀取 LINE 群組中...</option>';
    document.getElementById('line-publish-status').textContent = '';
    document.getElementById('line-publish-modal').classList.add('show');
    document.getElementById('line-publish-modal').setAttribute('aria-hidden', 'false');
    updateLineFlexPreview();

    const result = await cloudFetch('/api/line/groups');
    if (result.error || result.skipped) {
        document.getElementById('line-publish-group').innerHTML = '<option value="">無法讀取群組</option>';
        document.getElementById('line-publish-status').textContent = result.error || '尚未設定管理 API 金鑰';
        return;
    }
    const groups = result.data || [];
    document.getElementById('line-publish-group').innerHTML = groups.length
        ? groups.map(group => `<option value="${escapeLineText(group.group_id)}">${escapeLineText(group.display_name || '未命名群組')}｜${escapeLineText(group.group_id)}</option>`).join('')
        : '<option value="">尚無已知 LINE 群組</option>';
}

function closeLinePublishModal() {
    const modal = document.getElementById('line-publish-modal');
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
}

function updateLineFlexPreview() {
    const groupBuy = state.groupBuys.find(item => item.id === document.getElementById('line-publish-group-buy-id').value);
    const product = state.products.find(item => item.id === document.getElementById('line-publish-product').value) || state.products.find(item => item.enabled);
    const preview = document.getElementById('line-flex-preview');
    if (!groupBuy || !product) {
        preview.innerHTML = '<p>尚無可預覽內容</p>';
        return;
    }
    const quantities = selectedLinePublishQuantities();
    const image = document.getElementById('line-publish-show-image').checked && /^https:\/\//i.test(product.photo || '')
        ? `<img src="${escapeLineText(product.photo)}" alt="${escapeLineText(product.name)}">`
        : '';
    preview.innerHTML = `${image}<div class="line-flex-preview-body">
        <h4>${escapeLineText(product.name)}</h4>
        <p>${escapeLineText(product.specs || '無規格')}</p>
        <div class="line-flex-price">NT$ ${Number(product.price).toLocaleString()} <small>/ ${escapeLineText(product.unit || '份')}</small></div>
        <hr><p><strong>團購：</strong>${escapeLineText(groupBuy.name)}</p>
        <p class="line-flex-deadline"><strong>收單截止：</strong>${escapeLineText(groupBuy.endDate)} 23:59</p>
        <div class="line-flex-quantity-buttons">${quantities.map(quantity => `<span>${quantity}份</span>`).join('') || '<em>請至少選一個數量</em>'}</div>
        <div class="line-flex-secondary-button">取消訂購</div>
        <small>按鈕下單不會在聊天室產生訊息</small>
    </div>`;
}

async function publishLineProduct() {
    const groupId = document.getElementById('line-publish-group').value;
    const groupBuy = state.groupBuys.find(item => item.id === document.getElementById('line-publish-group-buy-id').value);
    const product = state.products.find(item => item.id === document.getElementById('line-publish-product').value);
    const quantities = selectedLinePublishQuantities();
    if (!groupId || !groupBuy || !product) return alert('請選擇 LINE 群組、團購與商品。');
    if (!quantities.length) return alert('請至少選擇一個數量按鈕。');
    if (!confirm(`確定將「${product.name}」商品卡發布到所選 LINE 群組？`)) return;

    const button = document.getElementById('line-publish-confirm-btn');
    const status = document.getElementById('line-publish-status');
    button.disabled = true;
    status.textContent = '正在同步團購與商品資料...';
    try {
        const productResult = await syncProductToCloud(product);
        if (productResult.error || productResult.skipped) throw new Error(productResult.error || '商品尚未同步');
        const groupResult = await cloudFetch(`/api/group-buys/${encodeURIComponent(groupBuy.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: groupBuy.name,
                starts_at: groupBuyDateTime(groupBuy.startDate),
                ends_at: groupBuyDateTime(groupBuy.endDate, true),
                status: groupBuyStatusForCloud(groupBuy.status),
                notes: groupBuy.notes || null,
                product_ids: [...new Set([product.id, ...(groupBuy.productIds || [])])]
            })
        });
        if (groupResult.error || groupResult.skipped) throw new Error(groupResult.error || '團購尚未同步');
        const payload = {
            group_id: groupId,
            group_buy_id: groupBuy.id,
            product_id: product.id,
            show_image: document.getElementById('line-publish-show-image').checked,
            quantities,
            published_by: '後台管理員'
        };
        const previewResult = await cloudFetch('/api/line/flex-preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        if (previewResult.error || previewResult.skipped) throw new Error(previewResult.error || 'Flex 預覽驗證失敗');
        status.textContent = '預覽驗證完成，正在發布到 LINE...';
        const publishResult = await cloudFetch('/api/line/publish', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        if (publishResult.error || publishResult.skipped) throw new Error(publishResult.error || '發布失敗');
        alert(`LINE 商品卡發布成功！\n發布紀錄：${publishResult.data.publication_id}`);
        closeLinePublishModal();
    } catch (error) {
        status.textContent = `發布失敗：${error.message}`;
    } finally {
        button.disabled = false;
    }
}


// ==========================================================================
// 3. 商品管理 (Product) 邏輯
// ==========================================================================
let productFilters = {
    search: "",
    sort: "id-asc"
};

function renderProducts() {
    const tbody = document.getElementById('products-tbody');
    const mobileList = document.getElementById('products-mobile-list');
    let html = "";
    let mobileHtml = "";

    // 篩選與排序
    let list = [...state.products];
    if (productFilters.search) {
        const s = productFilters.search.toLowerCase();
        list = list.filter(p => p.id.toLowerCase().includes(s) || p.name.toLowerCase().includes(s));
    }

    if (productFilters.sort === "id-asc") {
        list.sort((a, b) => a.id.localeCompare(b.id, undefined, {numeric: true}));
    } else if (productFilters.sort === "id-desc") {
        list.sort((a, b) => b.id.localeCompare(a.id, undefined, {numeric: true}));
    } else if (productFilters.sort === "name-asc") {
        list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant-TW"));
    }

    list.forEach(p => {
        const isUsed = state.orders.some(o => o.items.some(it => it.productId === p.id));
        const stock = stockFor(state.activeGroupBuyId, p.id);
        const statusBadge = p.enabled 
            ? `<span class="badge badge-paid">啟用中</span>` 
            : `<span class="badge badge-unpaid">已停用</span>`;

        html += `
            <tr>
                <td style="font-family: Outfit; font-weight: 700;">${escapeHtml(p.id)}</td>
                <td><div style="width:40px; height:40px; border-radius:8px; background-color:var(--bg-warm-gray); display:flex; align-items:center; justify-content:center; color:var(--text-muted);"><i class="fa-solid fa-image"></i></div></td>
                <td style="font-weight:700;">${escapeHtml(p.name)}</td>
                <td>${escapeHtml(p.specs || '-')}</td>
                <td style="font-weight:700; color:var(--primary-orange);">NT$ ${p.price}</td>
                <td>${escapeHtml(p.unit)}</td>
                <td>${statusBadge}</td>
                <td>${stock && stock.stockEnabled ? stock.sellableQuantity : '-'}</td>
                <td>${stock && stock.stockEnabled ? stock.soldQuantity : '-'}</td>
                <td>${stock && stock.stockEnabled ? stock.remainingQuantity : '-'}</td>
                <td>${stockStatusBadge(stock)}</td>
                <td>
                    <div class="button-group">
                        <button class="btn btn-secondary btn-sm" onclick="openProductModal('${p.id}')"><i class="fa-solid fa-edit"></i> 編輯</button>
                        <button class="btn btn-secondary btn-sm" onclick="toggleProductStatus('${p.id}')">${p.enabled ? '停用' : '啟用'}</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')" ${isUsed ? 'disabled title="已有訂單記錄，無法刪除，請選擇停用"' : ''}><i class="fa-solid fa-trash"></i> 刪除</button>
                    </div>
                </td>
            </tr>
        `;

        // 手機版卡片
        mobileHtml += `
            <div class="mobile-card">
                <div class="mobile-card-row">
                    <span class="mobile-card-title"><span class="badge badge-id">${escapeHtml(p.id)}</span> ${escapeHtml(p.name)}</span>
                    <span>${statusBadge}</span>
                </div>
                <div class="mobile-card-divider"></div>
                <div class="mobile-card-row">
                    <span style="color:var(--text-muted);">規格：${escapeHtml(p.specs || '-')}</span>
                    <span style="font-weight:700; color:var(--primary-orange);">NT$ ${p.price} / ${escapeHtml(p.unit)}</span>
                </div>
                <div class="mobile-card-row">
                    <span>${stockStatusBadge(stock)}</span>
                    <span>${stock && stock.stockEnabled ? `可賣 ${stock.sellableQuantity}｜已售 ${stock.soldQuantity}｜剩餘 ${stock.remainingQuantity}` : '本團不限量'}</span>
                </div>
                <div class="mobile-card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="openProductModal('${p.id}')"><i class="fa-solid fa-edit"></i> 編輯</button>
                    <button class="btn btn-secondary btn-sm" onclick="toggleProductStatus('${p.id}')">${p.enabled ? '停用' : '啟用'}</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')" ${isUsed ? 'disabled' : ''}><i class="fa-solid fa-trash"></i> 刪除</button>
                </div>
            </div>
        `;
    });

    tbody.innerHTML = html || `<tr><td colspan="12" style="text-align:center; color:var(--text-muted);">無商品資料</td></tr>`;
    mobileList.innerHTML = mobileHtml || `<div style="text-align:center; color:var(--text-muted); padding:20px;">無商品資料</div>`;
}

function onProductFilterChange() {
    productFilters.search = document.getElementById('product-search-input').value.trim();
    productFilters.sort = document.getElementById('product-sort-select').value;
    renderProducts();
}

function resetProductFilters() {
    document.getElementById('product-search-input').value = "";
    document.getElementById('product-sort-select').value = "id-asc";
    productFilters = { search: "", sort: "id-asc" };
    renderProducts();
}

// --- 商品繁體中文語音輸入 ---
let productVoiceRecognizer = null;
let productVoiceParsed = null;
let productVoiceField = null;

function getSpeechRecognitionConstructor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setProductVoiceStatus(message, isListening = false) {
    const status = document.getElementById('product-voice-status');
    const button = document.getElementById('product-voice-record-btn');
    if (status) status.textContent = message;
    if (button) {
        button.classList.toggle('is-listening', isListening);
        button.innerHTML = isListening ? '<i class="fa-solid fa-stop"></i> 停止錄音' : '<i class="fa-solid fa-microphone"></i> 開始錄音';
    }
}

function setProductVoiceError(message = '') {
    const error = document.getElementById('product-voice-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
}

function getProductVoiceErrorMessage(code) {
    if (code === 'not-allowed' || code === 'service-not-allowed') return '麥克風權限遭拒絕，請改用手動輸入';
    if (code === 'audio-capture') return '尚未取得麥克風權限';
    if (code === 'no-speech') return '沒有偵測到語音，請重新嘗試';
    return '語音辨識失敗，請改用手動輸入';
}

function stopProductVoiceRecognition(statusMessage = '已停止錄音') {
    if (productVoiceRecognizer) productVoiceRecognizer.stop();
    productVoiceRecognizer = null;
    productVoiceField = null;
    document.querySelectorAll('.voice-field-btn').forEach(button => button.classList.remove('is-listening'));
    const inlineStatus = document.getElementById('product-field-voice-status');
    if (inlineStatus && inlineStatus.textContent === '正在聆聽…') inlineStatus.textContent = statusMessage;
    setProductVoiceStatus(statusMessage, false);
}

function createProductRecognizer(onResult, onEnd) {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) return null;
    return ProductVoice.createSpeechRecognizer({
        Recognition,
        onResult,
        onError(code) {
            const message = getProductVoiceErrorMessage(code);
            setProductVoiceError(message);
            const inlineStatus = document.getElementById('product-field-voice-status');
            if (inlineStatus) inlineStatus.textContent = message;
        },
        onEnd() {
            productVoiceRecognizer = null;
            productVoiceField = null;
            document.querySelectorAll('.voice-field-btn').forEach(button => button.classList.remove('is-listening'));
            setProductVoiceStatus('已停止錄音', false);
            if (onEnd) onEnd();
        }
    });
}

function startProductFieldVoice(field) {
    stopProductVoiceRecognition('已停止錄音');
    const fieldConfig = {
        name: { input: 'prod-name', normalize: value => value.trim() },
        specs: { input: 'prod-specs', normalize: ProductVoice.normalizeSpecs },
        price: { input: 'prod-price', normalize: ProductVoice.parsePrice },
        unit: { input: 'prod-unit', normalize: value => value.trim() }
    }[field];
    if (!fieldConfig || !getSpeechRecognitionConstructor()) return;
    const inlineStatus = document.getElementById('product-field-voice-status');
    const button = document.querySelector(`[data-voice-field="${field}"]`);
    productVoiceField = field;
    productVoiceRecognizer = createProductRecognizer(transcript => {
        const value = fieldConfig.normalize(transcript);
        if (field === 'price' && value === null) {
            inlineStatus.textContent = '無法辨識售價，請手動確認';
            return;
        }
        document.getElementById(fieldConfig.input).value = value;
        inlineStatus.textContent = '辨識完成，請確認內容後再儲存商品';
    });
    if (productVoiceRecognizer && productVoiceRecognizer.start()) {
        if (button) button.classList.add('is-listening');
        inlineStatus.textContent = '正在聆聽…';
    }
}

function resetProductVoicePreview() {
    productVoiceParsed = null;
    document.getElementById('product-voice-transcript').textContent = '尚未辨識';
    ['name', 'specs', 'price', 'unit'].forEach(field => document.getElementById(`voice-preview-${field}`).textContent = '—');
    document.getElementById('product-voice-apply-btn').disabled = true;
    document.getElementById('product-voice-retry-btn').disabled = true;
    setProductVoiceError('');
    setProductVoiceStatus('請開始說話', false);
}

function openProductVoiceModal() {
    if (!getSpeechRecognitionConstructor()) {
        alert('此瀏覽器暫不支援語音輸入，請改用鍵盤輸入');
        return;
    }
    if (!document.getElementById('product-modal').classList.contains('show')) openProductModal();
    resetProductVoicePreview();
    const modal = document.getElementById('product-voice-modal');
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
}

function closeProductVoiceModal() {
    stopProductVoiceRecognition('已停止錄音');
    const modal = document.getElementById('product-voice-modal');
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
}

function toggleProductVoiceRecording() {
    if (productVoiceRecognizer && productVoiceRecognizer.isActive()) {
        stopProductVoiceRecognition('已停止錄音');
        return;
    }
    setProductVoiceError('');
    setProductVoiceStatus('正在聆聽…', true);
    productVoiceRecognizer = createProductRecognizer(transcript => {
        setProductVoiceStatus('正在整理商品資料…', false);
        productVoiceParsed = ProductVoice.parseProductSpeech(transcript);
        document.getElementById('product-voice-transcript').textContent = transcript;
        document.getElementById('voice-preview-name').textContent = productVoiceParsed.name || '—';
        document.getElementById('voice-preview-specs').textContent = productVoiceParsed.specs || '—';
        document.getElementById('voice-preview-price').textContent = productVoiceParsed.price === null ? '—' : productVoiceParsed.price;
        document.getElementById('voice-preview-unit').textContent = productVoiceParsed.unit || '—';
        document.getElementById('product-voice-apply-btn').disabled = !(productVoiceParsed.name || productVoiceParsed.specs || productVoiceParsed.price !== null || productVoiceParsed.unit);
        document.getElementById('product-voice-retry-btn').disabled = false;
        if (productVoiceParsed.priceError) setProductVoiceError('無法辨識售價，請手動確認');
        else if (productVoiceParsed.missingFields.length) setProductVoiceError('語音內容不完整，請補充缺少的欄位');
        setProductVoiceStatus('辨識完成', false);
    });
    if (!productVoiceRecognizer || !productVoiceRecognizer.start()) {
        setProductVoiceError('語音辨識失敗，請改用手動輸入');
        setProductVoiceStatus('已停止錄音', false);
    }
}

function restartProductVoice() {
    stopProductVoiceRecognition('已停止錄音');
    resetProductVoicePreview();
    toggleProductVoiceRecording();
}

function applyProductVoiceToForm() {
    if (!productVoiceParsed) return;
    if (productVoiceParsed.name) document.getElementById('prod-name').value = productVoiceParsed.name;
    if (productVoiceParsed.specs) document.getElementById('prod-specs').value = productVoiceParsed.specs;
    if (productVoiceParsed.price !== null) document.getElementById('prod-price').value = productVoiceParsed.price;
    if (productVoiceParsed.unit) document.getElementById('prod-unit').value = productVoiceParsed.unit;
    closeProductVoiceModal();
    document.getElementById('product-field-voice-status').textContent = '已套用到表單，請確認內容後按「儲存商品」';
}

function initializeProductVoiceSupport() {
    const supported = Boolean(getSpeechRecognitionConstructor());
    document.querySelectorAll('.voice-field-btn').forEach(button => button.disabled = !supported);
    const quickButton = document.getElementById('product-voice-quick-btn');
    if (quickButton) quickButton.disabled = !supported;
    const message = document.getElementById('product-voice-support-message');
    if (message) message.hidden = supported;
}

function openProductModal(id = '') {
    const modal = document.getElementById('product-modal');
    const title = document.getElementById('product-modal-title');
    const form = document.getElementById('product-form');
    
    form.reset();
    document.getElementById('prod-id').readOnly = false;

    if (id) {
        title.textContent = "編輯商品資料";
        const p = state.products.find(x => x.id === id);
        if (p) {
            document.getElementById('prod-id').value = p.id;
            document.getElementById('prod-id').readOnly = true; // ID不允許編輯
            document.getElementById('prod-name').value = p.name;
            document.getElementById('prod-specs').value = p.specs;
            document.getElementById('prod-price').value = p.price;
            document.getElementById('prod-pickup-price').value = (p.pickupPrice == null ? '' : p.pickupPrice);
            document.getElementById('prod-delivery-price').value = (p.deliveryPrice == null ? '' : p.deliveryPrice);
            document.getElementById('prod-unit').value = p.unit;
            document.getElementById('prod-enabled').value = String(p.enabled);
            document.getElementById('prod-desc').value = p.description || '';
            document.getElementById('prod-photo').value = p.photo;
        }
    } else {
        title.textContent = "新增商品";
        document.getElementById('prod-enabled').value = "true";
        
        // 自動推算下一個商品編號 P001...
        let maxNum = 0;
        state.products.forEach(p => {
            const match = p.id.match(/^P(\d+)$/i);
            if (match) {
                const n = parseInt(match[1], 10);
                if (n > maxNum) maxNum = n;
            }
        });
        document.getElementById('prod-id').value = 'P' + String(maxNum + 1).padStart(3, '0');
    }
    modal.classList.add('show');
}

function closeProductModal() {
    closeProductVoiceModal();
    document.getElementById('product-modal').classList.remove('show');
}

async function saveProduct() {
    // 商品代碼統一保存為半形大寫（NFKC 全形轉半形＋大寫，與 Worker normalizeLineCode 一致）
    const id = document.getElementById('prod-id').value.trim().normalize('NFKC').toUpperCase();
    const name = document.getElementById('prod-name').value.trim();
    const specs = document.getElementById('prod-specs').value.trim();
    const priceVal = document.getElementById('prod-price').value;
    const pickupPriceVal = document.getElementById('prod-pickup-price').value;
    const deliveryPriceVal = document.getElementById('prod-delivery-price').value;
    const unit = document.getElementById('prod-unit').value.trim();
    const enabled = document.getElementById('prod-enabled').value === "true";
    const description = document.getElementById('prod-desc').value.trim();
    const photo = document.getElementById('prod-photo').value.trim();

    if (!id || !name || !priceVal || !unit) {
        alert("請填寫商品編號、名稱、售價與單位！");
        return;
    }

    const price = parseFloat(priceVal);
    if (isNaN(price) || price < 0) {
        alert("售價必須是大於等於 0 的數字！");
        return;
    }

    // 雙價：自取價／外送價選填，留空＝null（下單時回退售價）；有填須為非負整數
    const parseOptionalPrice = (raw, label) => {
        if (raw == null || String(raw).trim() === '') return null;
        const n = Math.round(Number(raw));
        if (isNaN(n) || n < 0) { alert(`${label}必須是大於等於 0 的整數！`); return undefined; }
        return n;
    };
    const pickupPrice = parseOptionalPrice(pickupPriceVal, '自取價');
    if (pickupPrice === undefined) return;
    const deliveryPrice = parseOptionalPrice(deliveryPriceVal, '外送價');
    if (deliveryPrice === undefined) return;

    const existingIdx = state.products.findIndex(p => p.id === id);
    const isEdit = document.getElementById('prod-id').readOnly;

    if (!isEdit && existingIdx > -1) {
        alert(`商品編號 ${id} 已存在，請使用其他編號！`);
        return;
    }

    if (isEdit) {
        // 編輯
        if (existingIdx > -1) {
            state.products[existingIdx] = { id, name, specs, price, pickupPrice, deliveryPrice, unit, enabled, description, photo };
        }
    } else {
        // 新增
        state.products.push({ id, name, specs, price, pickupPrice, deliveryPrice, unit, enabled, description, photo });
    }

    saveStateToStorage();
    closeProductModal();
    renderProducts();

    // 雲端同步：先同步商品資料，再上傳圖片（若有選擇檔案）
    const product = state.products.find(p => p.id === id);
    let syncResult = await syncProductToCloud(product);
    const fileInput = document.getElementById('prod-photo-file');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (file && !syncResult.skipped && !syncResult.error) {
        const uploadResult = await uploadProductImageToCloud(id, file);
        if (uploadResult.error) {
            syncResult = { error: `圖片上傳失敗：${uploadResult.error}` };
        } else if (uploadResult.data && uploadResult.data.image_url) {
            product.photo = uploadResult.data.image_url;
            saveStateToStorage();
        }
        fileInput.value = '';
    }
    alert(`商品資料儲存成功！${cloudSyncSuffix(syncResult)}`);
}

function toggleProductStatus(id) {
    const p = state.products.find(x => x.id === id);
    if (p) {
        p.enabled = !p.enabled;
        saveStateToStorage();
        renderProducts();
        syncProductToCloud(p).then(result => {
            alert(`已成功將商品 ${id} 狀態切換為：${p.enabled ? '啟用' : '停用'}${cloudSyncSuffix(result)}`);
        });
    }
}

// --- 雲端商品同步（D1 / R2，供 LINE 靜默收單解析與記事本文案使用） ---
function getCloudApiKey() {
    return localStorage.getItem('easygo_line_admin_api_key') || '';
}

async function cloudFetch(path, options = {}) {
    const key = getCloudApiKey();
    if (!key) return { skipped: true };
    try {
        const response = await fetch(`${API_BASE_URL}${path}`, {
            ...options,
            headers: { authorization: `Bearer ${key}`, ...(options.headers || {}) }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            return {
                error: payload.message || payload.error || `HTTP ${response.status}`,
                code: payload.error || null,
                status: response.status,
                details: payload
            };
        }
        return { data: payload };
    } catch (error) {
        return { error: error.message || '網路錯誤' };
    }
}

function productToCloudPayload(p) {
    return JSON.stringify({
        name: p.name,
        line_code: p.id,
        price: Math.round(Number(p.price) || 0),
        pickup_price: (p.pickupPrice == null || p.pickupPrice === '') ? null : Math.round(Number(p.pickupPrice)),
        delivery_price: (p.deliveryPrice == null || p.deliveryPrice === '') ? null : Math.round(Number(p.deliveryPrice)),
        specs: p.specs || null,
        unit: p.unit || '份',
        description: p.description || [p.specs, p.unit && `單位：${p.unit}`].filter(Boolean).join('；') || null,
        image_url: /^https?:\/\//i.test(p.photo || '') ? p.photo : null,
        enabled: !!p.enabled
    });
}

// ==========================================================================
// 列印功能（包貨單／商品總量表／外送與自取名單）2026-07-22 驗收新增
// ==========================================================================
function printActiveOrders() {
    return state.orders.filter(o => o.groupBuyId === state.activeGroupBuyId && o.orderStatus !== '已取消');
}

// 雙價有效單價：自取→pickupPrice||price，外送→deliveryPrice||price；
// 商品缺雙價或找不到商品時回退品項當時單價（it.price），保持向後相容。
function effectiveUnitPrice(item, pickupType) {
    const prod = state.products.find(p => p.id === item.productId);
    if (prod) {
        if (pickupType === '外送' && prod.deliveryPrice != null && prod.deliveryPrice !== '') return Number(prod.deliveryPrice);
        if (pickupType === '自取' && prod.pickupPrice != null && prod.pickupPrice !== '') return Number(prod.pickupPrice);
    }
    return Number(item.price) || 0;
}

// 依有效單價重算整張訂單金額（自取／外送雙價）。
function effectiveOrderTotal(order) {
    return (order.items || []).reduce((sum, it) => sum + effectiveUnitPrice(it, order.pickupType) * (Number(it.quantity) || 0), 0);
}

function printGroupBuyTitle() {
    const gb = state.groupBuys.find(g => g.id === state.activeGroupBuyId);
    return gb ? gb.name : '';
}

function runPrint(html) {
    const area = document.getElementById('print-area');
    if (!area) return alert('找不到列印區域');
    area.innerHTML = html;
    window.print();
}

// 個別客戶包貨單：每位客戶一頁
function printPackingSlips() {
    const orders = printActiveOrders();
    if (!orders.length) return alert('目前團購沒有有效訂單可列印。');
    const title = printGroupBuyTitle();
    const pages = orders.map(o => {
        const rows = (o.items || []).map(it => {
            const unitPrice = effectiveUnitPrice(it, o.pickupType);
            return `<tr>
            <td>${escapeHtml(it.productName)}</td><td>${escapeHtml(it.specs || '')}</td>
            <td>${Number(it.quantity)} ${escapeHtml(it.unit || '')}</td>
            <td>NT$ ${unitPrice.toLocaleString()}</td>
            <td>NT$ ${(unitPrice * Number(it.quantity)).toLocaleString()}</td></tr>`;
        }).join('');
        return `<div class="print-page">
            <h2>包貨單｜${escapeHtml(title)}</h2>
            <div class="print-meta">
                客戶編號：${escapeHtml(o.customerId)}　客戶暱稱：${escapeHtml(orderCustomerName(o))}<br>
                取貨方式：${escapeHtml(o.pickupType || '未指定')}　電話：${escapeHtml(o.phone || '')}
                ${o.pickupType === '外送' ? `<br>地址：${escapeHtml(o.address || '')}` : ''}
            </div>
            <table><thead><tr><th>商品名稱</th><th>規格</th><th>數量</th><th>單價</th><th>小計</th></tr></thead>
            <tbody>${rows}</tbody></table>
            <p class="print-total">總金額：NT$ ${effectiveOrderTotal(o).toLocaleString()}（${escapeHtml(o.paymentStatus)}）</p>
            ${o.notes ? `<p class="print-note">備註：${escapeHtml(o.notes)}</p>` : ''}
        </div>`;
    });
    runPrint(pages.join(''));
}

// 商品總量表（叫貨統計）
function printProductTotals() {
    const orders = printActiveOrders();
    const groupBuy = state.groupBuys.find(g => g.id === state.activeGroupBuyId);
    const totals = {};
    groupBuyProducts(groupBuy).forEach(product => {
        totals[product.id] = {
            name: product.name,
            specs: product.specs || '',
            unit: product.unit || '',
            quantity: 0,
            customers: new Set()
        };
    });
    orders.forEach(o => (o.items || []).forEach(it => {
        const key = it.productId;
        if (!totals[key]) totals[key] = { name: it.productName, specs: it.specs || '', unit: it.unit || '', quantity: 0, customers: new Set() };
        totals[key].quantity += Number(it.quantity) || 0;
        totals[key].customers.add(o.customerId);
    }));
    const rows = Object.keys(totals).sort().map(id => {
        const t = totals[id];
        const stock = stockFor(state.activeGroupBuyId, id);
        return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.specs)}</td>
            <td>${stock?.stockEnabled ? stock.sellableQuantity : '不限量'}</td>
            <td>${stock?.stockEnabled ? stock.soldQuantity : t.quantity}</td>
            <td>${stock?.stockEnabled ? stock.remainingQuantity : '—'}</td>
            <td>${escapeHtml(stockStatusLabel(stock))}</td><td>${t.customers.size}</td></tr>`;
    }).join('');
    if (!rows) return alert('目前團購沒有商品可列印。');
    runPrint(`<div class="print-page">
        <h2>商品總量表｜${escapeHtml(printGroupBuyTitle())}</h2>
        <table class="inventory-print-table"><thead><tr><th>編號</th><th>商品</th><th>規格</th><th>可賣</th><th>已售</th><th>剩餘</th><th>狀態</th><th>客戶</th></tr></thead>
        <tbody>${rows}</tbody></table>
    </div>`);
}

// 外送／自取名單（未指定取貨方式的訂單獨立列出，避免漏包）
function printPickupList(type) {
    const orders = printActiveOrders();
    const matched = orders.filter(o => (o.pickupType || '') === type);
    const unspecified = orders.filter(o => !o.pickupType);
    if (!matched.length && !unspecified.length) return alert(`目前團購沒有${type}訂單可列印。`);
    const rowsOf = (list) => list.map(o => `<tr>
        <td>${escapeHtml(o.customerId)}</td><td>${escapeHtml(orderCustomerName(o))}</td>
        <td>${escapeHtml(o.phone || '')}</td>
        <td>${type === '外送' ? escapeHtml(o.address || '') : escapeHtml((o.items || []).map(it => `${it.productName}×${it.quantity}`).join('、'))}</td>
        <td>NT$ ${effectiveOrderTotal(o).toLocaleString()}</td>
        <td>${escapeHtml(o.paymentStatus)}${o.notes ? `／${escapeHtml(o.notes)}` : ''}</td></tr>`).join('');
    const head = `<tr><th>客戶編號</th><th>客戶暱稱</th><th>電話</th><th>${type === '外送' ? '地址' : '商品內容'}</th><th>金額</th><th>付款／備註</th></tr>`;
    runPrint(`<div class="print-page">
        <h2>${escapeHtml(type)}名單｜${escapeHtml(printGroupBuyTitle())}</h2>
        <table><thead>${head}</thead><tbody>${rowsOf(matched)}</tbody></table>
        ${unspecified.length ? `<h3>未指定取貨方式（請確認）</h3>
        <table><thead>${head}</thead><tbody>${rowsOf(unspecified)}</tbody></table>` : ''}
    </div>`);
}

// 把 LINE 靜默收單（Postback）在 D1 建立的訂單同步回本機訂單管理／統計／Excel。
// 只同步 ORD- 前綴（雲端產生）的訂單，不覆蓋手動建立的本地訂單；
// 已同步訂單保留本地的付款狀態、包貨勾選與備註，只更新品項數量與金額。
// 先把雲端客戶（含團主自訂名稱）同步回本機，再同步訂單，
// 這樣訂單顯示才會拿到「024-蜜茶」而不是 LINE 原始名稱「蜜茶」。
// 雲端 D1 是客戶名稱的單一真實來源（團主一按儲存就會 PUT 上去）。
async function syncCustomersFromCloud() {
    if (!getCloudApiKey()) return { skipped: true };
    const result = await cloudFetch('/api/customers');
    if (result.error || result.skipped) return result;
    const rows = Array.isArray(result.data) ? result.data : [];
    let changed = 0;
    const cloudCustomerIds = new Set(rows.filter(row => row && row.id).map(row => row.id));
    rows.forEach(row => {
        if (!row || !row.id) return;
        const idx = state.customers.findIndex(c => c.id === row.id);
        // 雲端 D1 是客戶名冊的真實來源：本機沒有的客戶要建出來，
        // 否則團主在客戶管理看不到 LINE 自動建立的客戶，就無法替他設定名稱。
        const local = idx > -1 ? state.customers[idx] : { phone: '', address: '', notes: '' };
        const merged = {
            ...local,
            id: row.id,
            // 雲端沒有自訂名稱時保留本機值：PUT 可能因離線／金鑰錯誤而尚未成功，
            // 不可讓同步把團主剛改好的名稱靜默還原成 LINE 原始名稱。
            customDisplayName: row.custom_display_name || local.customDisplayName || null,
            lineDisplayName: row.line_display_name || local.lineDisplayName || '',
            lineUserId: row.line_user_id || local.lineUserId || '',
            // 電話只存在本機，雲端沒有這個欄位，保留本機值
            address: local.address || row.address || '',
            pickupType: local.pickupType || row.pickup_type || '',
            phone: local.phone || '',
            // 備註（本名）migration-008 之後存在雲端：有雲端值就用雲端值（跨裝置的真相來源），
            // 雲端還沒有值（舊資料 NULL／PUT 尚未成功）才保留本機值，不可讓同步把本機備註洗成空白。
            notes: row.notes || local.notes || (row.profile_status === 'pending' ? 'LINE 自動建立，請補齊電話與地址' : '')
        };
        merged.nickname = CustomerName.mirrorNickname(merged, row.id);
        if (idx > -1) state.customers[idx] = merged; else state.customers.push(merged);
        changed += 1;
    });

    // 雲端已刪除的 LINE 暫存客戶，若本機只剩「已取消、0 元、無品項」訂單，
    // 代表沒有交易內容需要保留；一併清掉 LocalStorage 殘影。
    // 只處理 LINE- 編號且採嚴格條件，避免誤刪離線建立的正式客戶或有效訂單。
    const removableCustomerIds = new Set(state.customers
        .filter(customer => {
            if (!customer || !/^LINE-/i.test(customer.id) || cloudCustomerIds.has(customer.id)) return false;
            const relatedOrders = state.orders.filter(order => order.customerId === customer.id);
            return relatedOrders.every(order =>
                order.orderStatus === '已取消'
                && Number(order.totalAmount || 0) === 0
                && (!Array.isArray(order.items) || order.items.length === 0)
            );
        })
        .map(customer => customer.id));

    if (removableCustomerIds.size > 0) {
        const customerCountBefore = state.customers.length;
        const orderCountBefore = state.orders.length;
        state.customers = state.customers.filter(customer => !removableCustomerIds.has(customer.id));
        state.orders = state.orders.filter(order => !removableCustomerIds.has(order.customerId));
        changed += (customerCountBefore - state.customers.length) + (orderCountBefore - state.orders.length);
    }

    if (changed) saveStateToStorage();
    return { data: { synced: changed } };
}

function stockKey(groupBuyId, productId) {
    return `${groupBuyId}::${productId}`;
}

function stockFor(groupBuyId, productId) {
    return state.groupBuyStock[stockKey(groupBuyId, productId)] || null;
}

async function loadGroupBuyStock(groupBuyId) {
    if (!groupBuyId || !getCloudApiKey()) return { skipped: true };
    const result = await cloudFetch(`/api/group-buys/${encodeURIComponent(groupBuyId)}/stock`);
    if (result.error || result.skipped) return result;
    const stocks = (result.data && result.data.stocks) || [];
    stocks.forEach(stock => {
        state.groupBuyStock[stockKey(groupBuyId, stock.productId)] = stock;
    });
    return { data: { stocks } };
}

async function loadInventoryMovements(groupBuyId) {
    if (!groupBuyId || !getCloudApiKey()) return { skipped: true };
    const result = await cloudFetch(`/api/inventory/movements?group_buy_id=${encodeURIComponent(groupBuyId)}`);
    if (result.error || result.skipped) return result;
    state.inventoryMovements = (result.data && result.data.movements) || [];
    return { data: { movements: state.inventoryMovements } };
}

function stockStatusLabel(stock) {
    if (!stock || !stock.stockEnabled) return '不限量';
    if (stock.stockStatus === 'sold_out') return '已售完';
    if (stock.stockStatus === 'low_stock') return '即將售完';
    return '庫存充足';
}

function stockStatusBadge(stock) {
    const cls = !stock || !stock.stockEnabled ? 'stock-unlimited'
        : stock.stockStatus === 'sold_out' ? 'stock-sold-out'
            : stock.stockStatus === 'low_stock' ? 'stock-low' : 'stock-in';
    return `<span class="badge ${cls}">${stockStatusLabel(stock)}</span>`;
}

async function syncLineOrdersFromCloud(groupBuyId = state.activeGroupBuyId) {
    if (!getCloudApiKey() || !groupBuyId) return { skipped: true };
    const result = await cloudFetch(`/api/orders?group_buy_id=${encodeURIComponent(groupBuyId)}`);
    if (result.error || result.skipped) return result;
    const orders = (result.data && result.data.orders) || [];
    const items = (result.data && result.data.items) || [];
    const itemsByOrder = {};
    items.forEach(it => { (itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || []).push(it); });
    let changed = 0;
    orders.forEach(o => {
        // 自動建立／補齊本機客戶列：LINE 原始名稱與團主自訂名稱分開存，
        // 絕不用 LINE 原始名稱覆蓋團主已設定的名稱。
        if (o.customer_id) {
            const idx = state.customers.findIndex(c => c.id === o.customer_id);
            const local = idx > -1 ? state.customers[idx] : null;
            const merged = {
                ...(local || {}),
                id: o.customer_id,
                customDisplayName: o.custom_display_name || (local ? local.customDisplayName : null) || null,
                lineDisplayName: o.line_display_name || (local ? local.lineDisplayName : '') || '',
                phone: (local && local.phone) || '',
                address: (local && local.address) || o.address || '',
                notes: (local && local.notes) || 'LINE 靜默收單自動建立，請補齊電話與地址'
            };
            merged.nickname = CustomerName.mirrorNickname(merged, o.customer_display_name || o.customer_nickname || o.customer_id);
            if (idx > -1) state.customers[idx] = merged; else state.customers.push(merged);
        }
        const customer = state.customers.find(c => c.id === o.customer_id) || {};
        const existing = state.orders.find(x => x.id === o.id);
        const activeItems = (itemsByOrder[o.id] || []).filter(it => it.item_status === 'active').map(it => ({
            productId: it.product_id || it.product_code,
            productName: it.product_name || it.product_code || it.product_id,
            specs: it.specs || '',
            quantity: Number(it.quantity) || 0,
            price: Number(it.unit_price) || 0,
            unit: it.unit || '份'
        }));
        const mapped = {
            id: o.id,
            groupBuyId: o.group_buy_id,
            customerId: o.customer_id,
            // 訂單只保留「下單當時」的歷史名稱 snapshot；畫面顯示一律走 orderCustomerName() 重新解析，
            // 所以這裡即使存 LINE 原始名稱也不會讓後台顯示回「蜜茶」。
            customerNickname: (existing && existing.customerNickname) || o.customer_display_name || o.customer_nickname || o.customer_id,
            phone: o.phone_snapshot || customer.phone || (existing && existing.phone) || '',
            address: o.address_snapshot || (existing && existing.address) || o.address || customer.address || '',
            pickupType: (existing && existing.pickupType) || o.pickup_type || o.customer_pickup_type || '',
            items: activeItems,
            totalAmount: Number(o.total_amount) || 0,
            paymentStatus: o.payment_status || (existing && existing.paymentStatus) || '未付款',
            // 只保留本地的包貨流程狀態；取消／取消後復活（再下單）一律以雲端為準（2026-07-23 修正）
            orderStatus: o.status === '已取消' ? '已取消'
                : ((existing && ['已確認', '已包貨', '已完成'].includes(existing.orderStatus)) ? existing.orderStatus : '新訂單'),
            notes: o.notes || (existing && existing.notes) || 'LINE 商品卡靜默收單',
            createdDate: String(o.created_at || '').replace('T', ' ').slice(0, 19),
            checkedProductIds: (existing && existing.checkedProductIds) || []
        };
        const idx = state.orders.findIndex(x => x.id === o.id);
        if (idx > -1) state.orders[idx] = mapped; else state.orders.push(mapped);
        changed += 1;
    });
    // 訂單同步後再補齊客戶資料（團主自訂名稱、取貨方式、外送地址）
    await syncCustomersFromCloud();
    if (changed) saveStateToStorage();
    return { data: { synced: changed } };
}

async function syncProductToCloud(p) {
    return cloudFetch(`/api/products/${encodeURIComponent(p.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: productToCloudPayload(p)
    });
}

async function deleteProductFromCloud(id) {
    const result = await cloudFetch(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (result.error === '找不到商品') return { data: { deleted: false } };
    return result;
}

async function uploadProductImageToCloud(id, file) {
    return cloudFetch(`/api/products/${encodeURIComponent(id)}/image`, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file
    });
}

function cloudSyncSuffix(result) {
    if (!result) return '';
    if (result.skipped) return '\n（尚未設定 API 金鑰，未同步雲端；請至「LINE 靜默收單設定」輸入）';
    if (result.error) return `\n（⚠️ 雲端同步失敗：${result.error}）`;
    return '\n（☁️ 已同步雲端）';
}

async function syncAllProductsToCloud() {
    if (!getCloudApiKey()) {
        alert('請先到「LINE 靜默收單設定」輸入 API 金鑰！');
        return;
    }
    if (!state.products.length) {
        alert('目前沒有商品可同步。');
        return;
    }
    let ok = 0;
    const failed = [];
    for (const p of state.products) {
        const result = await syncProductToCloud(p);
        if (result.error) failed.push(`${p.id}：${result.error}`); else ok += 1;
    }
    alert(`雲端同步完成：成功 ${ok} 筆${failed.length ? `，失敗 ${failed.length} 筆\n${failed.join('\n')}` : ''}`);
}

// --- LINE 記事本文案 ---
function openLineNoteModal() {
    const gb = state.groupBuys.find(g => g.id === state.activeGroupBuyId);
    // 只列「本團商品」；團購未勾選商品時退回所有啟用中商品
    const note = LineNote.generateLineNote(groupBuyProducts(gb), gb ? {
        title: `阿賢Easy購｜${gb.name}`,
        deadline: gb.endDate || '',
        notes: gb.notes || ''
    } : {});
    if (!note) {
        const hasEnabledProducts = state.products.some(p => p.enabled);
        const gbHasSelection = gb && Array.isArray(gb.productIds) && gb.productIds.length > 0;
        if (hasEnabledProducts && gbHasSelection) {
            alert(`目前團購「${gb.name}」勾選的商品都已停用。\n請到「團購活動」編輯本團商品勾選，或切換當前團購。`);
        } else {
            alert('目前沒有啟用中的商品，請先啟用商品再產生文案！');
        }
        return;
    }
    document.getElementById('line-note-textarea').value = note;
    document.getElementById('line-note-modal').classList.add('show');
}

function closeLineNoteModal() {
    document.getElementById('line-note-modal').classList.remove('show');
}

// 下載啟用中商品的圖片（LINE 記事本無法自動顯示連結圖片，需手動附圖；此功能方便一次存圖）
async function downloadLineNoteImages() {
    const gb = state.groupBuys.find(g => g.id === state.activeGroupBuyId);
    const targets = groupBuyProducts(gb).filter(p => p.enabled && /^https?:\/\//i.test(p.photo || ''));
    if (!targets.length) {
        alert('啟用中的商品沒有可下載的圖片（請先在商品管理上傳或填寫圖片網址）。');
        return;
    }
    let done = 0;
    const failed = [];
    for (const p of targets) {
        try {
            const response = await fetch(p.photo);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const extension = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${p.id}_${p.name}.${extension}`.replace(/[\\/:*?"<>|]/g, '_');
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 10000);
            done += 1;
        } catch (_error) {
            failed.push(p.id);
        }
    }
    alert(`已下載 ${done} 張商品圖。${failed.length ? `\n下載失敗：${failed.join('、')}（可點文案中的連結手動儲存）` : '\n請在 LINE 記事本用「照片」功能附上。'}`);
}

async function copyLineNote() {
    const text = document.getElementById('line-note-textarea').value;
    try {
        await navigator.clipboard.writeText(text);
        alert('文案已複製！貼到 LINE 群組記事本即可。');
    } catch (_error) {
        document.getElementById('line-note-textarea').select();
        document.execCommand('copy');
        alert('文案已複製（相容模式）！貼到 LINE 群組記事本即可。');
    }
}

function deleteProduct(id) {
    const isUsed = state.orders.some(o => o.items.some(it => it.productId === id));
    if (isUsed) {
        alert("此商品已被訂購過，系統規定不可永久刪除，請使用停用功能！");
        return;
    }

    if (confirm(`確定要永久刪除商品「${id} ｜ ${state.products.find(p=>p.id===id).name}」嗎？`)) {
        state.products = state.products.filter(p => p.id !== id);
        saveStateToStorage();
        renderProducts();
        deleteProductFromCloud(id).then(result => {
            alert(`商品已刪除！${cloudSyncSuffix(result)}`);
        });
    }
}


// ==========================================================================
// 4. 客戶管理 (Customer) 邏輯
// ==========================================================================
let customerFilters = {
    search: ""
};

function renderCustomers() {
    const tbody = document.getElementById('customers-tbody');
    const mobileList = document.getElementById('customers-mobile-list');
    let html = "";
    let mobileHtml = "";

    let list = [...state.customers];
    if (customerFilters.search) {
        const s = customerFilters.search.toLowerCase();
        list = list.filter(c => 
            c.id.toLowerCase().includes(s) || 
            customerDisplayName(c).toLowerCase().includes(s) || 
            String(c.lineDisplayName || '').toLowerCase().includes(s) || 
            c.phone.includes(s) || 
            c.address.toLowerCase().includes(s)
        );
    }

    // 依客戶編號自然排序
    list.sort((a, b) => a.id.localeCompare(b.id, undefined, {numeric: true}));

    list.forEach(c => {
        const hasHistory = state.orders.some(o => o.customerId === c.id);
        
        html += `
            <tr>
                <td style="font-family: Outfit; font-weight:700;"><span class="badge badge-id">${escapeHtml(c.id)}</span></td>
                <td style="font-weight:700;">${escapeHtml(customerDisplayName(c))}${lineNameHintHtml(c)}</td>
                <td style="font-family: Outfit;">${escapeHtml(c.phone)}</td>
                <td style="font-size:13px;">${c.address ? escapeHtml(c.address) : '<span style="color:var(--text-muted);">自取客戶/無地址</span>'}</td>
                <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(c.notes || '')}</td>
                <td>
                    <div class="button-group">
                        <button class="btn btn-secondary btn-sm" onclick="openCustomerModal('${c.id}')"><i class="fa-solid fa-edit"></i> 編輯</button>
                        <button class="btn btn-teal btn-sm" onclick="viewCustomerHistory('${c.id}')" ${!hasHistory ? 'disabled title="尚無訂購歷史記錄"' : ''}><i class="fa-solid fa-history"></i> 歷史訂購</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')" ${hasHistory ? 'disabled title="已有訂單記錄，無法刪除"' : ''}><i class="fa-solid fa-trash"></i> 刪除</button>
                    </div>
                </td>
            </tr>
        `;

        // 手機版卡片
        mobileHtml += `
            <div class="mobile-card">
                <div class="mobile-card-row">
                    <span class="mobile-card-title"><span class="badge badge-id">${escapeHtml(c.id)}</span> ${escapeHtml(customerDisplayName(c))}${lineNameHintHtml(c)}</span>
                    <span style="font-family:Outfit; font-weight:500;">${escapeHtml(c.phone)}</span>
                </div>
                <div class="mobile-card-divider"></div>
                <div style="font-size:13px; color:var(--text-dark);">
                    <i class="fa-solid fa-location-dot" style="color:var(--primary-coral); width:16px;"></i> ${escapeHtml(c.address || '無外送地址 (自取)')}
                </div>
                <div style="font-size:13px; color:var(--text-muted);">
                    <i class="fa-solid fa-note-sticky" style="width:16px;"></i> 備註：${escapeHtml(c.notes || '無')}
                </div>
                <div class="mobile-card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="openCustomerModal('${c.id}')"><i class="fa-solid fa-edit"></i> 編輯</button>
                    <button class="btn btn-teal btn-sm" onclick="viewCustomerHistory('${c.id}')" ${!hasHistory ? 'disabled' : ''}><i class="fa-solid fa-history"></i> 歷史訂購</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')" ${hasHistory ? 'disabled' : ''}><i class="fa-solid fa-trash"></i> 刪除</button>
                </div>
            </div>
        `;
    });

    tbody.innerHTML = html || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">無客戶資料</td></tr>`;
    mobileList.innerHTML = mobileHtml || `<div style="text-align:center; color:var(--text-muted); padding:20px;">無客戶資料</div>`;
}

// 客戶列表小字提示：顯示 LINE 原始名稱，讓團主知道自訂名稱蓋掉了什麼
function lineNameHintHtml(c) {
    const lineName = String((c && c.lineDisplayName) || '').trim();
    if (!lineName || lineName === customerDisplayName(c)) return '';
    return `<div style="font-size:11px; color:var(--text-muted); font-weight:400;">LINE 名稱：${escapeHtml(lineName)}</div>`;
}

// 客戶編輯視窗提示：說明留空會回退 LINE 原始名稱
function renderCustomerLineNameHint(c) {
    const hint = document.getElementById('cust-line-name-hint');
    if (!hint) return;
    const lineName = String((c && c.lineDisplayName) || '').trim();
    if (!lineName) {
        hint.style.display = 'none';
        hint.textContent = '';
        return;
    }
    hint.style.display = 'block';
    hint.textContent = `此客戶的 LINE 原始名稱為「${lineName}」；留空則顯示 LINE 原始名稱。`;
}

function onCustomerFilterChange() {
    customerFilters.search = document.getElementById('customer-search-input').value.trim();
    renderCustomers();
}

function resetCustomerFilters() {
    document.getElementById('customer-search-input').value = "";
    customerFilters.search = "";
    renderCustomers();
}

// 電話格式去空格式化，以便精準比對
function formatPhoneForCompare(phone) {
    if (!phone) return "";
    return phone.replace(/[\s\(\)\-\+（）]/g, "");
}

// 疑似重複客戶警示檢查
function checkDuplicateCustomerWarning() {
    const id = document.getElementById('cust-id').value.trim().toUpperCase();
    const nickname = document.getElementById('cust-nickname').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();
    const address = document.getElementById('cust-address').value.trim();
    const editMode = document.getElementById('customer-edit-mode').value;
    const currentEditId = editMode === 'edit' ? id : '';

    const alertBox = document.getElementById('customer-duplicate-alert');
    const alertMsg = document.getElementById('customer-duplicate-alert-msg');
    
    alertBox.style.display = 'none';

    if (!nickname && !phone) return;

    const cleanPhone = formatPhoneForCompare(phone);
    const duplicates = [];

    state.customers.forEach(c => {
        // 編輯模式排除自己
        if (currentEditId && c.id === currentEditId) return;

        // 規則 1：ID 重複 (主要在儲存時卡控，這裡也提示)
        if (!currentEditId && id && c.id === id) {
            duplicates.push(`編號 [${c.id}] 已被使用`);
        }

        // 規則 2：電話號碼去格式後相同
        if (cleanPhone && formatPhoneForCompare(c.phone) === cleanPhone) {
            duplicates.push(`電話與客戶 [${c.id} ${customerDisplayName(c)}] 重複`);
        }

        // 規則 3：暱稱且地址完全相同
        if (nickname && address && customerDisplayName(c) === nickname && c.address === address) {
            duplicates.push(`暱稱與地址與客戶 [${c.id} ${customerDisplayName(c)}] 相同`);
        }
    });

    if (duplicates.length > 0) {
        alertMsg.innerHTML = `<strong>重複提醒：</strong>` + escapeHtml(duplicates.join('、')) + "，請確認是否為重複建檔！";
        alertBox.style.display = 'flex';
    }
}

// 自動生成下一個 ID (A001, A002...)
function autoGenerateCustId() {
    let maxNum = 0;
    state.customers.forEach(c => {
        const match = c.id.match(/^A(\d+)$/i);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNum) maxNum = num;
        }
    });
    document.getElementById('cust-id').value = 'A' + String(maxNum + 1).padStart(3, '0');
    checkDuplicateCustomerWarning();
}

function openCustomerModal(id = '') {
    const modal = document.getElementById('customer-modal');
    const title = document.getElementById('customer-modal-title');
    const form = document.getElementById('customer-form');
    const alertBox = document.getElementById('customer-duplicate-alert');

    form.reset();
    alertBox.style.display = 'none';
    document.getElementById('cust-id').readOnly = false;

    if (id) {
        title.textContent = "編輯客戶資料";
        document.getElementById('customer-edit-mode').value = "edit";
        document.getElementById('cust-id').readOnly = true;
        const c = state.customers.find(x => x.id === id);
        if (c) {
            document.getElementById('cust-id').value = c.id;
            // 暱稱欄位＝團主自訂名稱；留空代表取消自訂、回退顯示 LINE 原始名稱。
            // 只預填「確實存在的自訂名稱」：沒有自訂名稱的 LINE 客戶要留空，
            // 否則團主只想改電話按存檔，就會把 LINE 原始名稱寫成自訂名稱（LINE 之後改名永不反映）。
            document.getElementById('cust-nickname').value = CustomerName.hasCustomName(c)
                ? String(c.customDisplayName)
                : (String(c.lineDisplayName || '').trim() ? '' : (c.nickname || ''));
            renderCustomerLineNameHint(c);
            document.getElementById('cust-phone').value = c.phone;
            document.getElementById('cust-address').value = c.address;
            // migration-008 之前建立的客戶雲端 notes 是 NULL，同步下來可能沒有這個欄位 → 一律回退空字串，
            // 否則欄位會顯示字面上的「undefined」，一按存檔就把它當成備註存回雲端。
            document.getElementById('cust-notes').value = c.notes || '';
        }
    } else {
        title.textContent = "新增客戶";
        document.getElementById('customer-edit-mode').value = "create";
        renderCustomerLineNameHint(null);
        autoGenerateCustId();
    }
    modal.classList.add('show');
}

function closeCustomerModal() {
    document.getElementById('customer-modal').classList.remove('show');
}

function saveCustomer() {
    const editModeValue = document.getElementById('customer-edit-mode').value;
    const rawId = document.getElementById('cust-id').value.trim();
    // 只有新增時才把編號正規化成大寫；LINE 自動建立的客戶編號是 LINE-<小寫hex>，
    // 編輯時大寫化會找不到本機客戶，導致「顯示儲存成功但其實沒改到」並在雲端建出幽靈客戶。
    const id = editModeValue === 'create' ? rawId.toUpperCase() : rawId;
    const nickname = document.getElementById('cust-nickname').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();
    const address = document.getElementById('cust-address').value.trim();
    const notes = document.getElementById('cust-notes').value.trim();
    const editMode = document.getElementById('customer-edit-mode').value;

    const existingIdx = state.customers.findIndex(c => c.id === id);
    const existing = existingIdx > -1 ? state.customers[existingIdx] : null;
    const lineDisplayName = String((existing && existing.lineDisplayName) || '').trim();

    if (!id) {
        alert("請輸入客戶編號！");
        return;
    }
    // LINE 客戶（已有 LINE 原始名稱）允許暱稱／電話留空：暱稱留空即取消自訂名稱、回退 LINE 原始名稱。
    if (!lineDisplayName && !nickname) {
        alert("請輸入客戶暱稱！");
        return;
    }

    if (editMode === 'create' && existingIdx > -1) {
        alert(`客戶編號 ${id} 已存在，請使用其他編號或自動推算！`);
        return;
    }
    if (editMode === 'edit' && existingIdx === -1) {
        alert(`找不到客戶編號 ${id}，請關閉視窗後重新整理再試。`);
        return;
    }

    // nickname 欄位＝團主自訂名稱（custom_display_name）。留空 → null，顯示時回退 LINE 原始名稱。
    const record = {
        ...(existing || {}),
        id,
        customDisplayName: nickname || null,
        lineDisplayName: existing ? (existing.lineDisplayName || '') : '',
        lineUserId: existing ? (existing.lineUserId || '') : '',
        phone,
        address,
        notes
    };
    // nickname 保留為「目前應顯示的名稱」鏡射值，讓舊資料與舊畫面不會壞。
    record.nickname = CustomerName.mirrorNickname(record, id);

    if (editMode === 'edit') {
        state.customers[existingIdx] = record;
        // 訂單只同步電話與地址；客戶名稱一律在顯示時透過 customerId 關聯查詢，
        // 不再把名稱寫死進訂單（訂單的 customerNickname 只留作下單當時的歷史紀錄）。
        state.orders.forEach(o => {
            if (o.customerId === id) {
                o.phone = phone;
                if (o.pickupType === "外送" && !o.address) {
                    o.address = address;
                }
            }
        });
    } else {
        state.customers.push(record);
    }

    saveStateToStorage();
    closeCustomerModal();
    renderCustomers();
    if (currentViewId === 'dashboard') renderDashboard();

    // 關鍵：把團主自訂名稱寫回雲端 D1，否則下次同步會被 LINE 原始名稱蓋回去。
    syncCustomerToCloud(record).then(result => {
        renderCustomers();
        alert(`客戶資料儲存成功！${cloudSyncSuffix(result)}`);
    });
}

// 把團主設定的客戶名稱／取貨方式／地址／備註寫回 D1（不送 line_user_id 與 LINE 原始名稱）
async function syncCustomerToCloud(c) {
    return cloudFetch(`/api/customers/${encodeURIComponent(c.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // 只送團主真正管理的欄位；地址留空時完全不帶，避免清掉客人在 LIFF 自己填的外送地址。
        // 備註（本名）相反：一律帶（含空字串），因為那是團主自己的筆記，清空也要同步清空，
        // 且只有送上雲端才能跨裝置看到（migration-008）。
        body: JSON.stringify({
            custom_display_name: c.customDisplayName || '',
            notes: String(c.notes || '').trim(),
            ...(String(c.address || '').trim() ? { address: String(c.address).trim() } : {}),
            ...(c.pickupType ? { pickup_type: c.pickupType } : {})
        })
    });
}

// ==========================================================================
// 客戶「快速貼上匯入」
// 解析規則與配號規則集中在 customer-paste-parse.js（前端／Worker／node 測試共用同一份）。
//
// 欄位對應照 Vanny 手動建檔的既有慣例（貼上的三碼編號不是客戶編號）：
//   id                  = 系統自動配號 A001／A002…（真正的號由 Worker 配發）
//   customDisplayName   = `<編號>-<LINE暱稱>`，例：005-小葉娃
//   lineDisplayName     = LINE 暱稱
//   nickname / notes    = 本名（notes 自 migration-008 起也存雲端 D1，換裝置看得到）
//   phone / address     = 留空，不覆蓋客人自己填的資料
//
// ⚠️ 貼上的編號一律當字串處理（"001" 不是 1），任何地方都不可 Number()。
// ⚠️ 只寫名稱三欄＋備註；電話／地址／LINE 綁定一律不動。
// ==========================================================================
const customerPasteState = { rows: [], submitting: false };

const CUSTOMER_PASTE_STATUS_LABEL = {
    ok: '可新增',
    exists: '客戶編號已存在',
    invalid: '資料格式錯誤',
    noname: '姓名空白'
};

function openCustomerPasteModal() {
    customerPasteState.rows = [];
    customerPasteState.submitting = false;
    const textarea = document.getElementById('customer-paste-textarea');
    if (textarea) textarea.value = '';
    resetCustomerPastePreview();
    document.getElementById('customer-paste-modal').classList.add('show');
    if (textarea) setTimeout(() => textarea.focus(), 120);
}

function closeCustomerPasteModal() {
    document.getElementById('customer-paste-modal').classList.remove('show');
}

function resetCustomerPastePreview() {
    const summary = document.getElementById('customer-paste-summary');
    const wrap = document.getElementById('customer-paste-preview-wrap');
    const tbody = document.getElementById('customer-paste-preview-tbody');
    const result = document.getElementById('customer-paste-result');
    const importBtn = document.getElementById('customer-paste-import-btn');
    if (summary) { summary.style.display = 'none'; summary.innerHTML = ''; }
    if (wrap) wrap.style.display = 'none';
    if (tbody) tbody.innerHTML = '';
    if (result) { result.style.display = 'none'; result.innerHTML = ''; }
    if (importBtn) importBtn.disabled = true;
}

function clearCustomerPasteInput() {
    const textarea = document.getElementById('customer-paste-textarea');
    if (textarea) textarea.value = '';
    customerPasteState.rows = [];
    resetCustomerPastePreview();
}

// 「已存在」判斷同時看本機 state.customers 與雲端 D1 最新名冊，
// 只看本機會漏掉 LINE 自動建立、還沒同步下來的客戶，導致預覽說可新增、實際被略過。
// 回傳的是「名冊快照陣列」而不是 id → 資料的 Map：
// 貼上的三碼編號不是 customers.id，比對要看 custom_display_name 的 `<編號>-` 前綴。
async function loadCustomerImportIndex() {
    const byId = new Map();
    state.customers.forEach(c => {
        if (!c || !c.id) return;
        byId.set(String(c.id), {
            id: String(c.id),
            customDisplayName: String(c.customDisplayName || ''),
            displayName: customerDisplayName(c),
            lineName: String(c.lineDisplayName || '')
        });
    });
    const result = await cloudFetch('/api/customers');
    if (result && result.data && Array.isArray(result.data)) {
        result.data.forEach(row => {
            if (!row || !row.id) return;
            byId.set(String(row.id), {
                id: String(row.id),
                customDisplayName: String(row.custom_display_name || ''),
                displayName: CustomerName.resolveDisplayName(row),
                lineName: String(row.line_display_name || '')
            });
        });
    }
    return {
        customers: [...byId.values()],
        cloudError: result && result.error ? result.error : '',
        cloudSkipped: Boolean(result && result.skipped)
    };
}

// 從名冊快照裡找「編號已存在」的那一筆（比 custom_display_name 前綴，不比 id）。
function findCustomerByPasteCode(customers, code) {
    if (!code) return null;
    return customers.find(c => CustomerPasteParse.matchesCustomerCode(c.customDisplayName, code)) || null;
}

async function parseCustomerPasteInput() {
    const textarea = document.getElementById('customer-paste-textarea');
    const parseBtn = document.getElementById('customer-paste-parse-btn');
    const text = textarea ? textarea.value : '';
    const parsed = CustomerPasteParse.parseCustomerPaste(text);
    if (!parsed.rows.length) {
        customerPasteState.rows = [];
        resetCustomerPastePreview();
        alert('沒有讀到任何資料，請先貼上客戶名單。');
        return;
    }
    if (parseBtn) parseBtn.disabled = true;
    let lookup = { customers: [], cloudError: '', cloudSkipped: true };
    try {
        lookup = await loadCustomerImportIndex();
    } finally {
        if (parseBtn) parseBtn.disabled = false;
    }
    // 預覽用的配號：真正的號碼由 Worker 端重算（避免兩個分頁同時匯入撞號），
    // 這裡只是讓團主先看到「大概會配到 A008 起」。
    const allocatePreviewId = CustomerPasteParse.createCustomerIdAllocator(lookup.customers.map(c => c.id));
    customerPasteState.rows = parsed.rows.map(row => {
        const current = row.status === 'ok' ? findCustomerByPasteCode(lookup.customers, row.code) : null;
        return {
            ...row,
            exists: Boolean(current),
            existingId: current ? current.id : '',
            currentName: current ? current.displayName : '',
            currentLineName: current ? current.lineName : '',
            previewId: row.status === 'ok' && !current ? allocatePreviewId() : '',
            mode: 'skip' // 已存在的客戶預設略過，避免誤覆蓋團主已設定好的名稱
        };
    });
    renderCustomerPastePreview(lookup);
}

function renderCustomerPastePreview(lookup) {
    const rows = customerPasteState.rows;
    const summary = document.getElementById('customer-paste-summary');
    const wrap = document.getElementById('customer-paste-preview-wrap');
    const tbody = document.getElementById('customer-paste-preview-tbody');
    const result = document.getElementById('customer-paste-result');
    const importBtn = document.getElementById('customer-paste-import-btn');
    if (result) { result.style.display = 'none'; result.innerHTML = ''; }

    const counts = { addable: 0, exists: 0, error: 0 };
    let html = '';
    rows.forEach((row, index) => {
        let statusKey = row.status;
        if (row.status === 'ok' && row.exists) statusKey = 'exists';
        if (statusKey === 'ok') counts.addable += 1;
        else if (statusKey === 'exists') counts.exists += 1;
        else counts.error += 1;

        const statusClass = statusKey === 'ok' ? 'paste-status-ok' : (statusKey === 'exists' ? 'paste-status-exists' : 'paste-status-error');
        let action = '';
        if (statusKey === 'exists') {
            action = `<select class="form-control" onchange="setCustomerPasteRowMode(${index}, this.value)">
                <option value="skip" selected>略過</option>
                <option value="update">更新原有客戶資料</option>
            </select>`;
        } else if (statusKey === 'ok') {
            action = '<span style="color:var(--text-muted);">新增</span>';
        } else {
            action = '<select class="form-control" disabled><option>不匯入</option></select>';
        }
        // 小字補充：新增列顯示「即將配到的內部編號＋顯示名稱」，已存在列顯示目前資料與它的內部編號。
        let hint = '';
        if (statusKey === 'ok') {
            const targetName = CustomerPasteParse.buildCustomDisplayName(row.code, row.lineName);
            hint = `<div style="font-size:11px; color:var(--text-muted); font-weight:400;">將顯示為 ${escapeHtml(targetName)}${row.previewId ? `（配號 ${escapeHtml(row.previewId)}）` : ''}</div>`;
        } else if (statusKey === 'exists' && (row.currentName || row.existingId)) {
            hint = `<div style="font-size:11px; color:var(--text-muted); font-weight:400;">目前：${escapeHtml(row.currentName || '（無名稱）')}${row.existingId ? `（${escapeHtml(row.existingId)}）` : ''}</div>`;
        }
        html += `
            <tr>
                <td class="paste-code">${escapeHtml(row.code) || '<span style="color:var(--text-muted);">—</span>'}</td>
                <td>${escapeHtml(row.name) || `<span style="color:var(--text-muted);">${escapeHtml(row.raw)}</span>`}${hint}</td>
                <td>${escapeHtml(row.lineName) || '<span style="color:var(--text-muted);">—</span>'}</td>
                <td><span class="paste-status ${statusClass}">${escapeHtml(CUSTOMER_PASTE_STATUS_LABEL[statusKey])}</span></td>
                <td>${action}</td>
            </tr>
        `;
    });

    if (tbody) tbody.innerHTML = html;
    if (wrap) wrap.style.display = 'block';
    if (summary) {
        const cloudNote = lookup && lookup.cloudSkipped
            ? '<br><b>提醒：</b>尚未設定雲端管理金鑰，「已存在」只比對到本機資料，且無法送出匯入。'
            : (lookup && lookup.cloudError ? `<br><b>提醒：</b>讀取雲端客戶名冊失敗（${escapeHtml(lookup.cloudError)}），「已存在」只比對到本機資料。` : '');
        // 貼上的編號只是顯示名稱前綴，內部客戶編號由系統自動配號，這裡先讓團主看到起號。
        const firstNewId = rows.find(row => row.previewId);
        const assignNote = counts.addable && firstNewId
            ? `<br><span style="font-size:12px;">系統將自動配號 ${escapeHtml(firstNewId.previewId)}…（實際號碼以雲端配發為準）。</span>`
            : '';
        summary.innerHTML = `共解析 ${rows.length} 筆：可新增 ${counts.addable} 筆／已存在 ${counts.exists} 筆／有問題 ${counts.error} 筆。${assignNote}${cloudNote}`;
        summary.style.display = 'block';
    }
    if (importBtn) importBtn.disabled = !(counts.addable + counts.exists);
}

function setCustomerPasteRowMode(index, mode) {
    const row = customerPasteState.rows[index];
    if (!row) return;
    row.mode = mode === 'update' ? 'update' : 'skip';
}

// 依匯入結果就地更新本機 state.customers（不重新整理頁面）；
// 真正的客戶編號（A00N）由 Worker 配發，一律以回傳的 detail.id 為準，不用前端預覽號。
// 欄位對應：custom_display_name = `<編號>-<LINE暱稱>`、line_display_name = LINE暱稱、
//           nickname / notes = 本名（Worker 也已把 notes 寫進 D1，這裡只是就地反映同一個值）；
//           電話／地址／LINE 綁定保留本機既有值。
function applyCustomerImportToState(data, items) {
    const byCode = new Map(items.map(item => [String(item.code), item]));
    const details = Array.isArray(data && data.details) ? data.details : [];
    let changed = 0;
    details.forEach(detail => {
        if (!detail || (detail.action !== 'created' && detail.action !== 'updated')) return;
        const item = byCode.get(String(detail.code));
        const id = String(detail.id || '');
        if (!item || !id) return;
        const idx = state.customers.findIndex(c => String(c.id) === id);
        const local = idx > -1 ? state.customers[idx] : {};
        const record = {
            ...local,
            id,
            customDisplayName: CustomerPasteParse.buildCustomDisplayName(item.code, item.lineName),
            lineDisplayName: item.lineName || local.lineDisplayName || '',
            nickname: item.name,
            lineUserId: local.lineUserId || '',
            phone: local.phone || '',
            address: local.address || '',
            notes: item.name
        };
        if (idx > -1) state.customers[idx] = record; else state.customers.push(record);
        changed += 1;
    });
    return changed;
}

function renderCustomerPasteResult(data) {
    const box = document.getElementById('customer-paste-result');
    if (!box) return;
    const details = Array.isArray(data.details) ? data.details : [];
    const problems = details.filter(d => d && (d.action === 'failed' || d.action === 'skipped'));
    const listHtml = problems.length
        ? `<ul>${problems.slice(0, 50).map(d => `<li>${escapeHtml(d.code || '（無編號）')}：${escapeHtml(d.note || '')}</li>`).join('')}${problems.length > 50 ? '<li>…</li>' : ''}</ul>`
        : '';
    // 實際配到的客戶編號要讓團主看到，之後在客戶管理才找得到人。
    const createdIds = details.filter(d => d && d.action === 'created' && d.id).map(d => String(d.id));
    const createdNote = createdIds.length
        ? `<br><span style="font-size:12px;">本次配號：${escapeHtml(createdIds.slice(0, 20).join('、'))}${createdIds.length > 20 ? ' …' : ''}</span>`
        : '';
    box.innerHTML = `<div class="paste-import-result">
        <b>匯入完成</b><br>
        成功新增：${Number(data.created) || 0} 筆<br>
        更新資料：${Number(data.updated) || 0} 筆<br>
        略過資料：${Number(data.skipped) || 0} 筆<br>
        錯誤資料：${Number(data.failed) || 0} 筆${createdNote}
        ${listHtml}
    </div>`;
    box.style.display = 'block';
}

async function confirmCustomerPasteImport() {
    const importBtn = document.getElementById('customer-paste-import-btn');
    if (customerPasteState.submitting) return;
    // 送出的是「貼上的編號」而不是 id：真正的客戶編號（A00N）由 Worker 端配發。
    const items = customerPasteState.rows
        .filter(row => row.status === 'ok')
        .map(row => ({
            code: row.code,
            name: row.name,
            lineName: row.lineName,
            mode: row.exists ? row.mode : 'skip',
            existingId: row.existingId || ''
        }));
    if (!items.length) {
        alert('沒有可匯入的資料，請先按「解析資料」。');
        return;
    }
    if (!getCloudApiKey()) {
        alert('尚未設定雲端管理金鑰，無法匯入客戶。請先在系統設定填入管理 API 金鑰。');
        return;
    }
    customerPasteState.submitting = true;
    const originalHtml = importBtn ? importBtn.innerHTML : '';
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 匯入中…';
    }
    try {
        const result = await cloudFetch('/api/customers/bulk-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        if (result.skipped) {
            alert('尚未設定雲端管理金鑰，無法匯入客戶。');
            return;
        }
        if (result.error) {
            alert(`匯入失敗：${result.error}`);
            return;
        }
        const data = result.data || {};
        applyCustomerImportToState(data, items);
        saveStateToStorage();
        renderCustomerPasteResult(data);
        // 立即刷新客戶列表（不重新整理頁面）：先就地更新，再拉一次雲端名冊補齊 LINE 名稱等欄位。
        renderCustomers();
        await syncCustomersFromCloud();
        saveStateToStorage();
        renderCustomers();
        if (currentViewId === 'dashboard') renderDashboard();
        // 剛匯入的客戶現在都已存在，重算預覽狀態避免團主重複按
        // （比對條件與伺服器一致：custom_display_name 的 `<編號>-` 前綴，不是 id）
        const known = state.customers.map(c => ({
            id: String(c.id),
            customDisplayName: String(c.customDisplayName || ''),
            displayName: customerDisplayName(c),
            lineName: String(c.lineDisplayName || '')
        }));
        customerPasteState.rows.forEach(row => {
            if (row.status !== 'ok' || row.exists) return;
            const current = findCustomerByPasteCode(known, row.code);
            if (!current) return;
            row.exists = true;
            row.existingId = current.id;
            row.currentName = current.displayName;
            row.currentLineName = current.lineName;
            row.previewId = '';
        });
        const resultBox = document.getElementById('customer-paste-result');
        const savedResultHtml = resultBox ? resultBox.innerHTML : '';
        renderCustomerPastePreview({ cloudSkipped: false, cloudError: '' });
        if (resultBox && savedResultHtml) { resultBox.innerHTML = savedResultHtml; resultBox.style.display = 'block'; }
    } finally {
        customerPasteState.submitting = false;
        if (importBtn) {
            importBtn.innerHTML = originalHtml;
            importBtn.disabled = false;
        }
    }
}

function deleteCustomer(id) {
    const hasHistory = state.orders.some(o => o.customerId === id);
    if (hasHistory) {
        alert("此客戶已有訂單紀錄，不可永久刪除，以維護訂單交易歷史！");
        return;
    }

    if (confirm(`確定要永久刪除客戶「${id} ｜ ${customerDisplayName(findCustomerById(id))}」嗎？`)) {
        state.customers = state.customers.filter(c => c.id !== id);
        saveStateToStorage();
        renderCustomers();
        // 一併清除雲端客戶列（背景執行，失敗不影響本機）
        cloudFetch(`/api/customers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        alert("客戶已刪除！");
    }
}

// 檢視客戶購買歷史歷史明細
function viewCustomerHistory(id) {
    const c = state.customers.find(x => x.id === id);
    if (!c) return;

    document.getElementById('cust-history-title').textContent = `[${c.id}] ${customerDisplayName(c)} 歷史訂購統計`;
    const tbody = document.getElementById('cust-history-tbody');
    
    // 找出所有此客戶的訂單
    const custOrders = state.orders.filter(o => o.customerId === id).sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));

    let html = "";
    custOrders.forEach(o => {
        const gb = state.groupBuys.find(g => g.id === o.groupBuyId);
        const gbName = gb ? gb.name : "未知團購";

        let itemStr = o.items.map(it => `${escapeHtml(it.productName)} (${escapeHtml(it.specs)}) x ${it.quantity}`).join('<br>');

        html += `
            <tr>
                <td style="font-size:13px; font-weight:700;">${escapeHtml(gbName)}</td>
                <td style="font-family:Outfit; font-weight:700;">${o.id}</td>
                <td><span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span></td>
                <td style="font-size:13px; line-height:1.4;">${itemStr}</td>
                <td style="font-weight:700; color:var(--primary-orange);">NT$ ${o.totalAmount}</td>
                <td><span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span></td>
                <td><span class="badge badge-status-${getStatusClass(o.orderStatus)}">${o.orderStatus}</span></td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
    openModal('customer-history-modal');
}


// ==========================================================================
// 5. 訂單管理 (Order) 邏輯
// ==========================================================================
let orderFilters = {
    search: "",
    pickup: "",
    payment: "",
    status: "", // 預設排除取消
    sort: "created-desc"
};

let selectedOrderIds = []; // 用於批次修改勾選
let orderViewMode = 'list'; // 'list', 'by-customer', 'by-product'

function toggleOrderViewMode(mode) {
    orderViewMode = mode;
    
    // 樣式調整
    document.getElementById('order-mode-list-btn').className = mode === 'list' ? 'btn btn-primary' : 'btn btn-secondary';
    document.getElementById('order-mode-customer-btn').className = mode === 'by-customer' ? 'btn btn-primary' : 'btn btn-secondary';
    document.getElementById('order-mode-product-btn').className = mode === 'by-product' ? 'btn btn-primary' : 'btn btn-secondary';

    // 視圖開關
    document.getElementById('order-list-subview').style.display = mode === 'list' ? 'block' : 'none';
    document.getElementById('order-customer-subview').style.display = mode === 'by-customer' ? 'block' : 'none';
    document.getElementById('order-product-subview').style.display = mode === 'by-product' ? 'block' : 'none';

    if (mode === 'list') {
        renderOrdersList();
    } else if (mode === 'by-customer') {
        renderCustomerSummaryView();
    } else if (mode === 'by-product') {
        renderProductSummaryView();
    }
}

// 渲染一般訂單列表
function renderOrdersList() {
    const tbody = document.getElementById('orders-tbody');
    const mobileList = document.getElementById('orders-mobile-list');
    let html = "";
    let mobileHtml = "";

    // 篩選當前選定團購活動的訂單
    let list = state.orders.filter(o => o.groupBuyId === state.activeGroupBuyId);

    // 搜尋過濾
    if (orderFilters.search) {
        const s = orderFilters.search.toLowerCase();
        list = list.filter(o => 
            o.id.toLowerCase().includes(s) || 
            o.customerId.toLowerCase().includes(s) || 
            orderCustomerNameForSort(o).toLowerCase().includes(s) || 
            (o.customerNickname || '').toLowerCase().includes(s) || 
            o.phone.includes(s) || 
            (o.address && o.address.toLowerCase().includes(s)) ||
            o.items.some(it => it.productName.toLowerCase().includes(s))
        );
    }

    // 取貨方式篩選
    if (orderFilters.pickup) {
        list = list.filter(o => o.pickupType === orderFilters.pickup);
    }

    // 付款篩選
    if (orderFilters.payment) {
        list = list.filter(o => o.paymentStatus === orderFilters.payment);
    }

    // 狀態篩選
    if (orderFilters.status === 'ALL_WITH_CANCEL') {
        // 不作過濾，顯示全部包含已取消
    } else if (orderFilters.status) {
        list = list.filter(o => o.orderStatus === orderFilters.status);
    } else {
        // 預設排除已取消的訂單
        list = list.filter(o => o.orderStatus !== '已取消');
    }

    // 排序
    const sortVal = orderFilters.sort;
    list.sort((a, b) => {
        if (sortVal === "created-desc") return new Date(b.createdDate) - new Date(a.createdDate);
        if (sortVal === "created-asc") return new Date(a.createdDate) - new Date(b.createdDate);
        
        // 客戶編號自然排序
        if (sortVal === "cust-id-asc") return a.customerId.localeCompare(b.customerId, undefined, {numeric: true});
        if (sortVal === "cust-id-desc") return b.customerId.localeCompare(a.customerId, undefined, {numeric: true});
        
        if (sortVal === "cust-name-asc") return orderCustomerNameForSort(a).localeCompare(orderCustomerNameForSort(b), "zh-Hant-TW");
        
        // 外送優先
        if (sortVal === "pickup-asc") {
            if (a.pickupType === b.pickupType) return 0;
            return a.pickupType === "外送" ? -1 : 1;
        }
        // 自取優先
        if (sortVal === "pickup-desc") {
            if (a.pickupType === b.pickupType) return 0;
            return a.pickupType === "自取" ? -1 : 1;
        }
        
        // 未付款優先
        if (sortVal === "payment-asc") {
            if (a.paymentStatus === b.paymentStatus) return 0;
            return a.paymentStatus === "未付款" ? -1 : 1;
        }

        // 未包貨優先
        if (sortVal === "status-packed-asc") {
            const getRank = (st) => ["新訂單", "已確認", "已包貨", "已完成", "已取消"].indexOf(st);
            return getRank(a.orderStatus) - getRank(b.orderStatus);
        }

        if (sortVal === "amount-desc") return b.totalAmount - a.totalAmount;
        
        return 0;
    });

    // 渲染
    list.forEach(o => {
        const isChecked = selectedOrderIds.includes(o.id) ? "checked" : "";
        const itemStr = o.items.map(it => `<div style="font-size:13px; line-height:1.4;">${escapeHtml(it.productName)} <span style="color:var(--text-muted);">(${escapeHtml(it.specs || '無規格')})</span> <strong>x ${it.quantity}</strong></div>`).join('');
        
        // 地址或配送說明
        let deliveryInfo = "";
        if (o.pickupType === "外送") {
            deliveryInfo = `<div style="font-size:12px; color:var(--text-muted);"><i class="fa-solid fa-map-marker-alt" style="color:var(--primary-coral);"></i> ${escapeHtml(o.address || '無外送地址')}</div>`;
        } else {
            deliveryInfo = `<div style="font-size:12px; color:var(--primary-teal);"><i class="fa-solid fa-house-user"></i> 自取</div>`;
        }

        html += `
            <tr style="${o.orderStatus === '已取消' ? 'opacity: 0.6;' : ''}">
                <td style="padding:16px 20px;"><input type="checkbox" class="order-item-checkbox" value="${o.id}" ${isChecked} onchange="onOrderSelectChange('${o.id}', this.checked)"></td>
                <td style="font-family: Outfit; font-weight:700;"><a onclick="viewOrderDetail('${o.id}')" style="color:var(--primary-orange); cursor:pointer;">${o.id}</a></td>
                <td><span class="badge badge-id">${escapeHtml(o.customerId)}</span></td>
                <td style="font-weight:700;">${escapeHtml(orderCustomerName(o))}</td>
                <td>
                    <div style="font-weight:500;">${escapeHtml(o.phone)}</div>
                    ${deliveryInfo}
                </td>
                <td>${itemStr}</td>
                <td style="font-weight:700; color:var(--primary-orange);">NT$ ${o.totalAmount}</td>
                <td><span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span></td>
                <td><span class="badge badge-status-${getStatusClass(o.orderStatus)}">${o.orderStatus}</span></td>
                <td>
                    <div class="button-group">
                        <button class="btn btn-secondary btn-sm" onclick="viewOrderDetail('${o.id}')"><i class="fa-solid fa-eye"></i> 查看</button>
                        <button class="btn btn-secondary btn-sm" onclick="openOrderModal('${o.id}')" ${o.orderStatus === '已完成' || o.orderStatus === '已取消' ? 'disabled' : ''}><i class="fa-solid fa-edit"></i> 編輯</button>
                        <button class="btn btn-danger btn-sm" onclick="cancelOrder('${o.id}')" ${o.orderStatus === '已取消' ? 'disabled' : ''}><i class="fa-solid fa-times-circle"></i> 取消</button>
                    </div>
                </td>
            </tr>
        `;

        // 手機版卡片
        mobileHtml += `
            <div class="mobile-card" style="${o.orderStatus === '已取消' ? 'opacity: 0.6;' : ''}">
                <div class="mobile-card-row">
                    <span class="mobile-card-title">
                        <a onclick="viewOrderDetail('${o.id}')" style="color:var(--primary-orange); cursor:pointer; font-family:Outfit; font-weight:900;">${o.id}</a>
                        <span class="badge badge-id">${escapeHtml(o.customerId)}</span>
                        <strong>${escapeHtml(orderCustomerName(o))}</strong>
                    </span>
                    <span class="badge badge-status-${getStatusClass(o.orderStatus)}">${o.orderStatus}</span>
                </div>
                <div class="mobile-card-divider"></div>
                <div class="mobile-card-items">
                    ${o.items.map(it => `<div>${escapeHtml(it.productName)} (${escapeHtml(it.specs)}) x ${it.quantity}</div>`).join('')}
                </div>
                <div class="mobile-card-row" style="font-size:13px;">
                    <span>取貨：<span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span></span>
                    <span>付款：<span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span></span>
                </div>
                ${o.pickupType === '外送' ? `<div style="font-size:12px; color:var(--text-muted);"><i class="fa-solid fa-map-marker-alt"></i> ${escapeHtml(o.address)}</div>` : ''}
                <div class="mobile-card-row">
                    <span style="font-weight:700; color:var(--primary-orange); font-size:16px;">NT$ ${o.totalAmount}</span>
                    <span style="font-size:12px; color:var(--text-muted);">${o.createdDate.substring(5,16)}</span>
                </div>
                <div class="mobile-card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="viewOrderDetail('${o.id}')">查看</button>
                    <button class="btn btn-secondary btn-sm" onclick="openOrderModal('${o.id}')" ${o.orderStatus === '已完成' || o.orderStatus === '已取消' ? 'disabled' : ''}>編輯</button>
                    <button class="btn btn-danger btn-sm" onclick="cancelOrder('${o.id}')" ${o.orderStatus === '已取消' ? 'disabled' : ''}>取消</button>
                </div>
            </div>
        `;
    });

    tbody.innerHTML = html || `<tr><td colspan="10" style="text-align:center; color:var(--text-muted);">查無符合條件之訂單</td></tr>`;
    mobileList.innerHTML = mobileHtml || `<div style="text-align:center; color:var(--text-muted); padding:20px;">查無符合條件之訂單</div>`;
    
    // 更新選取筆數顯示
    document.getElementById('selected-orders-count').textContent = selectedOrderIds.length;
}

function onOrderFilterChange() {
    orderFilters.search = document.getElementById('order-search-input').value.trim();
    orderFilters.pickup = document.getElementById('order-filter-pickup').value;
    orderFilters.payment = document.getElementById('order-filter-payment').value;
    orderFilters.status = document.getElementById('order-filter-status').value;
    orderFilters.sort = document.getElementById('order-sort-select').value;
    renderOrdersList();
}

function resetOrderFilters() {
    document.getElementById('order-search-input').value = "";
    document.getElementById('order-filter-pickup').value = "";
    document.getElementById('order-filter-payment').value = "";
    document.getElementById('order-filter-status').value = "";
    document.getElementById('order-sort-select').value = "created-desc";
    
    orderFilters = { search: "", pickup: "", payment: "", status: "", sort: "created-desc" };
    selectedOrderIds = [];
    document.getElementById('order-select-all').checked = false;
    renderOrdersList();
}

// 勾選框事件處理
function onOrderSelectChange(id, checked) {
    if (checked) {
        if (!selectedOrderIds.includes(id)) selectedOrderIds.push(id);
    } else {
        selectedOrderIds = selectedOrderIds.filter(x => x !== id);
    }
    document.getElementById('selected-orders-count').textContent = selectedOrderIds.length;
}

function toggleSelectAllOrders(checked) {
    selectedOrderIds = [];
    document.querySelectorAll('.order-item-checkbox').forEach(cb => {
        cb.checked = checked;
        if (checked) selectedOrderIds.push(cb.value);
    });
    document.getElementById('selected-orders-count').textContent = selectedOrderIds.length;
}

// 批次付款更新
async function persistAdminOrder(order, overrides = {}) {
    const orderStatus = overrides.orderStatus || order.orderStatus || '新訂單';
    return cloudFetch(`/api/admin/orders/${encodeURIComponent(order.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requestId: `admin-${crypto.randomUUID()}`,
            groupBuyId: order.groupBuyId,
            customerId: order.customerId,
            pickupType: order.pickupType || '自取',
            phone: order.phone || '',
            address: order.address || '',
            paymentStatus: overrides.paymentStatus || order.paymentStatus || '未付款',
            orderStatus,
            notes: order.notes || '',
            items: (order.items || []).map(item => ({
                productId: item.productId,
                quantity: Number(item.quantity),
                unitPrice: Number(item.price)
            }))
        })
    });
}

async function batchUpdatePayment(status) {
    if (selectedOrderIds.length === 0) {
        alert("請先勾選欲修改的訂單！");
        return;
    }
    if (!confirm(`確定要將選取的 ${selectedOrderIds.length} 筆訂單付款狀態修改為「${status}」嗎？`)) return;
    const orders = state.orders.filter(o => selectedOrderIds.includes(o.id));
    const results = await Promise.all(orders.map(order => persistAdminOrder(order, { paymentStatus: status })));
    const failed = results.find(result => result.error || result.skipped);
    if (failed) return alert(`批次修改失敗：${failed.error || '尚未設定後台 API 金鑰'}`);
    await syncLineOrdersFromCloud();
    saveStateToStorage();
    renderOrdersList();
    alert("批次修改成功！");
}

// 批次狀態更新
async function batchUpdateOrderStatus(status) {
    if (!status) return;
    if (selectedOrderIds.length === 0) {
        alert("請先勾選欲修改的訂單！");
        return;
    }
    if (!confirm(`確定要將選取的 ${selectedOrderIds.length} 筆訂單之訂單狀態修改為「${status}」嗎？`)) return;
    const orders = state.orders.filter(o => selectedOrderIds.includes(o.id));
    const results = await Promise.all(orders.map(order => persistAdminOrder(order, { orderStatus: status })));
    const failed = results.find(result => result.error || result.skipped);
    if (failed) return alert(`批次修改失敗：${failed.error || '尚未設定後台 API 金鑰'}`);
    await Promise.all([syncLineOrdersFromCloud(), loadGroupBuyStock(state.activeGroupBuyId)]);
    state.orders.forEach(o => {
        if (selectedOrderIds.includes(o.id) && status === '已包貨') o.checkedProductIds = o.items.map(it => it.productId);
    });
    saveStateToStorage();
    renderOrdersList();
    document.getElementById('batch-order-status-select').value = "";
    alert("批次狀態修改成功！");
}

// 單筆取消訂單 (不刪除資料)
async function cancelOrder(id) {
    if (!confirm(`確定要取消訂單 ${id} 嗎？商品數量會自動回補，但不會刪除訂單資料。`)) return;
    const order = state.orders.find(x => x.id === id);
    if (!order) return;
    const result = await persistAdminOrder(order, { orderStatus: '已取消' });
    if (result.error || result.skipped) {
        alert(`取消失敗：${result.error || '尚未設定後台 API 金鑰'}`);
        return;
    }
    await Promise.all([syncLineOrdersFromCloud(order.groupBuyId), loadGroupBuyStock(order.groupBuyId)]);
    saveStateToStorage();
    if (orderViewMode === 'list') renderOrdersList();
    else if (orderViewMode === 'by-customer') renderCustomerSummaryView();
    if (currentViewId === 'dashboard') renderDashboard();
    alert("訂單已取消，庫存已回補！");
}

// 檢視單筆訂單明細內容
function viewOrderDetail(id) {
    const o = state.orders.find(x => x.id === id);
    if (!o) return;

    let itemsHtml = "";
    o.items.forEach(it => {
        itemsHtml += `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-light);">
                <span>${escapeHtml(it.productName)} <span style="color:var(--text-muted); font-size:12px;">(${escapeHtml(it.specs || '無')})</span> x ${it.quantity} ${escapeHtml(state.products.find(p=>p.id===it.productId)?.unit || '個')}</span>
                <span style="font-weight:700;">NT$ ${it.price * it.quantity}</span>
            </div>
        `;
    });

    const content = `
        <div style="font-size:14px; line-height:1.8;">
            <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
                <span>訂單編號：<strong style="font-family:Outfit; font-size:16px;">${o.id}</strong></span>
                <span>建立時間：${o.createdDate}</span>
            </div>
            <div class="mobile-card-divider" style="margin:12px 0;"></div>
            <p><strong>客戶編號：</strong><span class="badge badge-id">${escapeHtml(o.customerId)}</span></p>
            <p><strong>客戶暱稱：</strong>${escapeHtml(orderCustomerName(o))}</p>
            <p><strong>連絡電話：</strong>${escapeHtml(o.phone)}</p>
            <p><strong>取貨方式：</strong><span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span></p>
            ${o.pickupType === '外送' ? `<p><strong>外送地址：</strong>${escapeHtml(o.address || '無')}</p>` : ''}
            <div class="mobile-card-divider" style="margin:12px 0;"></div>
            <p style="font-weight:700; margin-bottom:8px;">購買品項：</p>
            <div style="background-color:var(--bg-cream); padding:12px; border-radius:var(--radius-md); margin-bottom:12px;">
                ${itemsHtml}
                <div style="display:flex; justify-content:space-between; padding-top:8px; font-weight:900; color:var(--primary-orange); font-size:16px;">
                    <span>總額：</span>
                    <span>NT$ ${o.totalAmount}</span>
                </div>
            </div>
            <p><strong>付款狀態：</strong><span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span></p>
            <p><strong>訂單狀態：</strong><span class="badge badge-status-${getStatusClass(o.orderStatus)}">${o.orderStatus}</span></p>
            <p><strong>備註說明：</strong>${escapeHtml(o.notes || '無')}</p>
        </div>
    `;

    document.getElementById('order-view-content').innerHTML = content;
    openModal('order-view-modal');
}

// --- 購物車明細編輯功能 (Modal 內) ---
let cartItems = []; // 編輯中訂單的商品清單 [{productId, productName, specs, quantity, price, unit}]

async function openOrderModal(orderId = '') {
    const modal = document.getElementById('order-modal');
    const title = document.getElementById('order-modal-title');
    const form = document.getElementById('order-form');
    
    form.reset();
    document.getElementById('order-id').value = orderId;
    cartItems = [];

    // 載入活動下拉清單 (僅限開放或截止狀態)
    const activeGbs = state.groupBuys.filter(g => g.status !== '完成');
    let gbHtml = "";
    activeGbs.forEach(g => {
        gbHtml += `<option value="${escapeHtml(g.id)}" ${g.id === state.activeGroupBuyId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`;
    });
    document.getElementById('ord-group-buy').innerHTML = gbHtml || `<option value="">請先建立活動</option>`;

    // 載入客戶下拉清單 (依客戶編號自然排序)
    const sortedCusts = [...state.customers].sort((a, b) => a.id.localeCompare(b.id, undefined, {numeric: true}));
    let custHtml = `<option value="">-- 請選擇客戶 --</option>`;
    sortedCusts.forEach(c => {
        custHtml += `<option value="${escapeHtml(c.id)}">[${escapeHtml(c.id)}] ${escapeHtml(customerDisplayName(c))}</option>`;
    });
    document.getElementById('ord-customer-select').innerHTML = custHtml;

    if (orderId) {
        title.textContent = "編輯訂單資料";
        const o = state.orders.find(x => x.id === orderId);
        if (o) {
            document.getElementById('ord-group-buy').value = o.groupBuyId;
            document.getElementById('ord-customer-select').value = o.customerId;
            document.getElementById('ord-cust-nickname').value = orderCustomerName(o);
            document.getElementById('ord-cust-phone').value = o.phone;
            document.getElementById('ord-cust-address').value = o.address;
            document.getElementById('ord-pickup-type').value = o.pickupType;
            onOrderPickupTypeChange(o.pickupType);
            document.getElementById('ord-delivery-address').value = o.address;
            document.getElementById('ord-payment-status').value = o.paymentStatus;
            document.getElementById('ord-order-status').value = o.orderStatus;
            document.getElementById('ord-notes').value = o.notes;
            
            // 複製商品至購物車
            cartItems = o.items.map(it => {
                const prod = state.products.find(p => p.id === it.productId);
                return {
                    productId: it.productId,
                    productName: it.productName,
                    specs: it.specs,
                    quantity: it.quantity,
                    price: it.price, // 保留當時價格
                    unit: prod ? prod.unit : '個'
                };
            });
        }
    } else {
        title.textContent = "新增訂單";
        document.getElementById('ord-pickup-type').value = "自取";
        onOrderPickupTypeChange("自取");
        document.getElementById('ord-payment-status').value = "未付款";
        document.getElementById('ord-order-status').value = "新訂單";
        
        // 預設填入一行空白商品列
        addOrderItemRow();
    }

    await loadGroupBuyStock(document.getElementById('ord-group-buy').value);
    renderCartTable();
    modal.classList.add('show');
}

async function onOrderGroupBuyChange() {
    const groupBuyId = document.getElementById('ord-group-buy').value;
    await loadGroupBuyStock(groupBuyId);
    const groupBuy = state.groupBuys.find(g => g.id === groupBuyId);
    const allowed = new Set(groupBuyProducts(groupBuy).map(p => p.id));
    cartItems = cartItems.filter(item => allowed.has(item.productId));
    if (!cartItems.length) addOrderItemRow();
    renderCartTable();
}

function closeOrderModal() {
    document.getElementById('order-modal').classList.remove('show');
}

// 選擇客戶自動帶入資料
function onOrderCustomerSelect(custId) {
    const nicknameInput = document.getElementById('ord-cust-nickname');
    const phoneInput = document.getElementById('ord-cust-phone');
    const addressInput = document.getElementById('ord-cust-address');
    const deliveryAddress = document.getElementById('ord-delivery-address');

    if (!custId) {
        nicknameInput.value = "";
        phoneInput.value = "";
        addressInput.value = "";
        return;
    }

    const c = state.customers.find(x => x.id === custId);
    if (c) {
        nicknameInput.value = customerDisplayName(c);
        phoneInput.value = c.phone;
        addressInput.value = c.address || "";
        
        // 若當時選取外送，自動把預設地址複製進外送地址欄位中
        if (document.getElementById('ord-pickup-type').value === "外送") {
            deliveryAddress.value = c.address || "";
        }
    }
}

// 配送方式變更卡控
function onOrderPickupTypeChange(val) {
    const addressGroup = document.getElementById('ord-delivery-address-group');
    if (val === "外送") {
        addressGroup.style.display = 'flex';
        // 如果此時已經有選擇客戶，帶入預設地址
        const custId = document.getElementById('ord-customer-select').value;
        if (custId) {
            const c = state.customers.find(x => x.id === custId);
            if (c && !document.getElementById('ord-delivery-address').value) {
                document.getElementById('ord-delivery-address').value = c.address || "";
            }
        }
    } else {
        addressGroup.style.display = 'none';
    }
}

// 增加一行購物車商品
function addOrderItemRow() {
    // 預設帶入第一個啟用商品，若無商品則不執行
    const groupBuyId = document.getElementById('ord-group-buy')?.value || state.activeGroupBuyId;
    const activeProds = groupBuyProducts(state.groupBuys.find(g => g.id === groupBuyId)).filter(p => p.enabled);
    if (activeProds.length === 0) {
        alert("目前商品庫無啟用的商品，請先去「商品管理」新增商品並啟用！");
        return;
    }

    const defaultProd = activeProds[0];
    cartItems.push({
        productId: defaultProd.id,
        productName: defaultProd.name,
        specs: defaultProd.specs,
        quantity: 1,
        price: defaultProd.price, // 預設使用最新定價，但可自由修改
        unit: defaultProd.unit
    });

    renderCartTable();
}

// 渲染購物車表格
function renderCartTable() {
    const listContainer = document.getElementById('cart-items-list');
    const totalSpan = document.getElementById('cart-total-amount');
    
    const groupBuyId = document.getElementById('ord-group-buy')?.value || state.activeGroupBuyId;
    const activeProds = groupBuyProducts(state.groupBuys.find(g => g.id === groupBuyId)).filter(p => p.enabled);
    let html = "";
    let total = 0;

    cartItems.forEach((item, index) => {
        const subtotal = item.price * item.quantity;
        total += subtotal;
        const stock = stockFor(groupBuyId, item.productId);
        const editingOrder = state.orders.find(o => o.id === document.getElementById('order-id')?.value);
        const originalQty = Number(editingOrder?.items?.find(it => it.productId === item.productId)?.quantity || 0);
        const available = stock && stock.stockEnabled ? Number(stock.remainingQuantity || 0) + originalQty : null;
        const stockHint = stock && stock.stockEnabled
            ? `${stockStatusLabel(stock)}｜目前可再訂 ${Math.max(0, Number(stock.remainingQuantity || 0))} ${escapeHtml(item.unit || '')}`
            : '未啟用數量限制';

        // 產生商品選擇下拉清單
        let optHtml = "";
        activeProds.forEach(p => {
            const isSelected = p.id === item.productId ? "selected" : "";
            optHtml += `<option value="${escapeHtml(p.id)}" ${isSelected}>[${escapeHtml(p.id)}] ${escapeHtml(p.name)}</option>`;
        });

        html += `
            <div class="cart-item-row">
                <select class="form-control" onchange="onCartItemProductChange(${index}, this.value)">
                    ${optHtml}
                </select>
                <span style="font-size:13px; color:var(--text-muted); text-align:center;">${escapeHtml(item.specs || '-')}<small class="cart-stock-hint">${stockHint}</small></span>
                <input type="number" class="form-control" style="text-align:center;" value="${item.quantity}" min="1" ${available == null ? '' : `max="${available}"`} oninput="onCartItemQtyChange(${index}, this.value)">
                <input type="number" class="form-control" value="${item.price}" min="0" oninput="onCartItemPriceChange(${index}, this.value)">
                <span style="font-weight:700; text-align:right; font-family:Outfit;">NT$ ${subtotal}</span>
                <button type="button" class="btn btn-danger btn-sm" style="padding:6px 10px;" onclick="removeCartItemRow(${index})"><i class="fa-solid fa-trash"></i></button>
            </div>
        `;
    });

    listContainer.innerHTML = html || `<div style="text-align:center; color:var(--text-muted); padding:16px;">請點擊右上方「新增商品列」開始挑選商品。</div>`;
    totalSpan.textContent = total;
}

function onCartItemProductChange(index, prodId) {
    if (cartItems.some((item, itemIndex) => itemIndex !== index && item.productId === prodId)) {
        alert('同一張訂單內商品不可重複，請直接修改原商品列數量。');
        renderCartTable();
        return;
    }
    const prod = state.products.find(p => p.id === prodId);
    if (prod) {
        cartItems[index].productId = prod.id;
        cartItems[index].productName = prod.name;
        cartItems[index].specs = prod.specs;
        cartItems[index].price = prod.price; // 當前最新單價
        cartItems[index].unit = prod.unit;
        renderCartTable();
    }
}

function onCartItemQtyChange(index, val) {
    let qty = parseInt(val, 10);
    if (isNaN(qty) || qty <= 0) qty = 1;
    const groupBuyId = document.getElementById('ord-group-buy')?.value || state.activeGroupBuyId;
    const stock = stockFor(groupBuyId, cartItems[index].productId);
    const editingOrder = state.orders.find(o => o.id === document.getElementById('order-id')?.value);
    const originalQty = Number(editingOrder?.items?.find(it => it.productId === cartItems[index].productId)?.quantity || 0);
    if (stock && stock.stockEnabled) {
        const max = Number(stock.remainingQuantity || 0) + originalQty;
        if (qty > max) {
            qty = max;
            alert(`數量不可超過目前可用數量 ${max}。如需增加，請先使用「調整庫存」。`);
        }
    }
    cartItems[index].quantity = qty;
    renderCartTable();
}

function onCartItemPriceChange(index, val) {
    let price = parseFloat(val);
    if (isNaN(price) || price < 0) price = 0;
    cartItems[index].price = price;
    
    document.getElementById('cart-total-amount').textContent = cartItems.reduce((s, it) => s + (it.price * it.quantity), 0);
}

function removeCartItemRow(index) {
    cartItems.splice(index, 1);
    renderCartTable();
}

// 儲存訂單
async function saveOrder() {
    const existingOrderId = document.getElementById('order-id').value;
    const groupBuyId = document.getElementById('ord-group-buy').value;
    const customerId = document.getElementById('ord-customer-select').value;
    const nickname = document.getElementById('ord-cust-nickname').value.trim();
    const phone = document.getElementById('ord-cust-phone').value.trim();
    const pickupType = document.getElementById('ord-pickup-type').value;
    const address = pickupType === "外送" ? document.getElementById('ord-delivery-address').value.trim() : "";
    const paymentStatus = document.getElementById('ord-payment-status').value;
    const orderStatus = document.getElementById('ord-order-status').value;
    const notes = document.getElementById('ord-notes').value.trim();

    if (!groupBuyId || !customerId) {
        alert("請確認已建立團購活動，並正確選擇訂購客戶！");
        return;
    }

    if (pickupType === "外送" && !address) {
        alert("選擇外送時，配送地址欄位為必填項目！");
        return;
    }

    // 過濾無效購物車品項
    const finalItems = cartItems.filter(it => it.quantity > 0);
    if (finalItems.length === 0) {
        alert("訂單必須包含至少一項商品！");
        return;
    }

    if (!getCloudApiKey()) {
        alert('正式訂單必須連線至雲端 D1 才能安全扣庫存。請先在「LINE 設定」填入後台 API 金鑰。');
        return;
    }
    const orderId = existingOrderId || `ADM-${crypto.randomUUID()}`;
    const requestId = `admin-${crypto.randomUUID()}`;
    const result = await cloudFetch(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requestId,
            groupBuyId,
            customerId,
            pickupType,
            phone,
            address,
            paymentStatus,
            orderStatus,
            notes,
            items: finalItems.map(item => ({
                productId: item.productId,
                quantity: Number(item.quantity),
                unitPrice: Number(item.price)
            }))
        })
    });
    if (result.error || result.skipped) {
        const remaining = result.details?.remainingQuantity;
        alert(`${result.error || '訂單儲存失敗'}${remaining == null ? '' : `\n目前剩餘數量：${remaining}`}`);
        await loadGroupBuyStock(groupBuyId);
        renderCartTable();
        return;
    }
    await Promise.all([syncLineOrdersFromCloud(groupBuyId), loadGroupBuyStock(groupBuyId)]);
    saveStateToStorage();
    closeOrderModal();
    
    // 渲染對應子頁面
    if (orderViewMode === 'list') {
        renderOrdersList();
    } else if (orderViewMode === 'by-customer') {
        renderCustomerSummaryView();
    }
    
    if (currentViewId === 'dashboard') renderDashboard();
    alert(result.data?.duplicate ? '這筆請求先前已完成，未重複扣庫存。' : '訂單資料已寫入 D1，庫存同步完成！');
}


// ==========================================================================
// 6. 「依客戶整理」與包貨核對 邏輯
// ==========================================================================
function renderCustomerSummaryView() {
    const container = document.getElementById('customer-summary-container');
    const searchVal = document.getElementById('customer-summary-search').value.trim().toLowerCase();
    const unpackedOnly = document.getElementById('customer-summary-unpacked-only').checked;
    const sortVal = document.getElementById('customer-summary-sort').value;

    // 篩選當前活動的訂單
    let activeOrders = state.orders.filter(o => o.groupBuyId === state.activeGroupBuyId);

    // 搜尋與包貨狀態篩選
    if (searchVal) {
        activeOrders = activeOrders.filter(o => 
            o.customerId.toLowerCase().includes(searchVal) ||
            orderCustomerNameForSort(o).toLowerCase().includes(searchVal) ||
            (o.customerNickname || '').toLowerCase().includes(searchVal) ||
            o.phone.includes(searchVal) ||
            (o.address && o.address.toLowerCase().includes(searchVal))
        );
    }

    if (unpackedOnly) {
        // 只顯示未包貨 (新訂單、已確認，或者 checkedProductIds 尚未收齊)
        activeOrders = activeOrders.filter(o => o.orderStatus !== '已包貨' && o.orderStatus !== '已完成' && o.orderStatus !== '已取消');
    }

    // 排序
    activeOrders.sort((a, b) => {
        if (sortVal === "id-asc") return a.customerId.localeCompare(b.customerId, undefined, {numeric: true});
        if (sortVal === "id-desc") return b.customerId.localeCompare(a.customerId, undefined, {numeric: true});
        if (sortVal === "name-asc") return orderCustomerNameForSort(a).localeCompare(orderCustomerNameForSort(b), "zh-Hant-TW");
        
        if (sortVal === "delivery-first") {
            if (a.pickupType === b.pickupType) return 0;
            return a.pickupType === "外送" ? -1 : 1;
        }
        if (sortVal === "pickup-first") {
            if (a.pickupType === b.pickupType) return 0;
            return a.pickupType === "自取" ? -1 : 1;
        }
        
        if (sortVal === "unpaid-first") {
            if (a.paymentStatus === b.paymentStatus) return 0;
            return a.paymentStatus === "未付款" ? -1 : 1;
        }
        if (sortVal === "unpacked-first") {
            const aPacked = a.orderStatus === '已包貨' || a.orderStatus === '已完成';
            const bPacked = b.orderStatus === '已包貨' || b.orderStatus === '已完成';
            if (aPacked === bPacked) return 0;
            return aPacked ? 1 : -1;
        }
        if (sortVal === "amount-desc") {
            return b.totalAmount - a.totalAmount;
        }
        return 0;
    });

    let html = "";
    activeOrders.forEach(o => {
        const totalItemsCount = o.items.reduce((s, it) => s + it.quantity, 0);
        
        // 勾選明細進度
        const checkedCount = o.checkedProductIds ? o.checkedProductIds.length : 0;
        const isAllChecked = checkedCount === o.items.length && o.items.length > 0;
        
        // 是否顯示一鍵包貨完成按鈕
        const showQuickPackBtn = isAllChecked && !['已包貨', '已完成', '已取消'].includes(o.orderStatus);

        let packingChecklistHtml = "";
        o.items.forEach(it => {
            const isItChecked = o.checkedProductIds && o.checkedProductIds.includes(it.productId);
            packingChecklistHtml += `
                <li class="checklist-item ${isItChecked ? 'checked' : ''}" onclick="togglePackItem('${o.id}', '${it.productId}', event)">
                    <span class="item-text">
                        ${escapeHtml(it.productName)} <span style="color:var(--text-muted); font-size:12px;">(${escapeHtml(it.specs || '無')})</span>
                        <strong style="color:var(--primary-orange); font-size:16px; margin-left:8px;">x ${it.quantity}</strong>
                    </span>
                    <input type="checkbox" class="item-checkbox" ${isItChecked ? 'checked' : ''} onclick="event.stopPropagation(); togglePackItem('${o.id}', '${it.productId}', event)">
                </li>
            `;
        });

        html += `
            <div class="customer-summary-card">
                <div class="customer-summary-header" onclick="toggleDetailPanel('${o.id}')">
                    <div class="customer-info-left">
                        <span class="badge badge-id">${escapeHtml(o.customerId)}</span>
                        <span class="customer-name">${escapeHtml(orderCustomerName(o))}</span>
                        <span class="customer-contact"><i class="fa-solid fa-phone"></i> ${escapeHtml(o.phone)}</span>
                        <span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span>
                    </div>
                    
                    <div class="customer-summary-stats">
                        <span style="font-size:13px; font-weight:700;">品項：${o.items.length} 種 (共 ${totalItemsCount} 件)</span>
                        <span style="font-weight:900; color:var(--primary-orange);">NT$ ${o.totalAmount}</span>
                        <span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span>
                        <span class="badge badge-status-${getStatusClass(o.orderStatus)}" id="sum-badge-${o.id}">${o.orderStatus}</span>
                    </div>
                    
                    <div class="customer-summary-actions">
                        <span style="font-size:12px; font-weight:700; color:var(--primary-teal);">${checkedCount}/${o.items.length} 包核</span>
                        <i class="fa-solid fa-chevron-down text-muted" id="chevron-${o.id}"></i>
                    </div>
                </div>
                
                <div class="customer-detail-panel" id="detail-${o.id}">
                    <div class="form-grid" style="margin-bottom: 16px; font-size:13px; grid-template-columns: 2fr 1fr;">
                        <div>
                            <p><strong>外送地址：</strong>${o.pickupType === '外送' ? escapeHtml(o.address || '無') : '自取'}</p>
                            <p><strong>備註說明：</strong>${escapeHtml(o.notes || '無')}</p>
                        </div>
                        <div style="text-align:right;">
                            ${showQuickPackBtn ? `<button class="btn btn-teal btn-sm" id="btn-quickpack-${o.id}" onclick="quickMarkOrderPacked('${o.id}')"><i class="fa-solid fa-box-open"></i> 一鍵標記已包貨</button>` : ''}
                            ${isAllChecked ? `<span class="badge badge-paid" style="padding: 8px 12px; font-size:13px;"><i class="fa-solid fa-circle-check"></i> 包貨完成</span>` : ''}
                        </div>
                    </div>
                    
                    <ul class="packing-checklist">
                        ${packingChecklistHtml}
                    </ul>
                </div>
            </div>
        `;
    });

    container.innerHTML = html || `<div style="text-align:center; color:var(--text-muted); padding:30px; background-color:white; border-radius:var(--radius-lg); border:1px solid var(--border-light);">查無符合之客戶包貨資料</div>`;
}

function toggleDetailPanel(orderId) {
    const panel = document.getElementById(`detail-${orderId}`);
    const chevron = document.getElementById(`chevron-${orderId}`);
    if (panel) {
        const isShow = panel.classList.toggle('show');
        if (chevron) {
            chevron.className = isShow ? "fa-solid fa-chevron-up text-muted" : "fa-solid fa-chevron-down text-muted";
        }
    }
}

// 逐項包貨勾選
function togglePackItem(orderId, prodId, event) {
    if (event) event.stopPropagation();

    const o = state.orders.find(x => x.id === orderId);
    if (!o) return;

    if (!o.checkedProductIds) o.checkedProductIds = [];

    const idx = o.checkedProductIds.indexOf(prodId);
    if (idx > -1) {
        o.checkedProductIds.splice(idx, 1);
    } else {
        o.checkedProductIds.push(prodId);
    }

    saveStateToStorage();
    renderCustomerSummaryView();
    // 展開剛才點擊的這片
    toggleDetailPanel(orderId);
}

// 一鍵標記已包貨
function quickMarkOrderPacked(orderId) {
    const o = state.orders.find(x => x.id === orderId);
    if (o) {
        o.orderStatus = "已包貨";
        saveStateToStorage();
        renderCustomerSummaryView();
        toggleDetailPanel(orderId);
        if (currentViewId === 'dashboard') renderDashboard();
        alert(`訂單 ${orderId} 已標記為「已包貨」！`);
    }
}


// ==========================================================================
// 7. 「依商品整理」邏輯 (叫貨點貨統計)
// ==========================================================================
function renderProductSummaryView() {
    const tbody = document.getElementById('product-summary-tbody');
    const activeOrders = state.orders.filter(o => o.groupBuyId === state.activeGroupBuyId && o.orderStatus !== "已取消");
    const groupBuy = state.groupBuys.find(g => g.id === state.activeGroupBuyId);
    const stats = {};
    groupBuyProducts(groupBuy).forEach(product => {
        stats[product.id] = {
            id: product.id,
            name: product.name,
            specs: product.specs,
            totalQty: 0,
            unit: product.unit || '個',
            buyers: new Set()
        };
    });
    activeOrders.forEach(o => {
        o.items.forEach(it => {
            if (!stats[it.productId]) {
                stats[it.productId] = {
                    id: it.productId,
                    name: it.productName,
                    specs: it.specs,
                    totalQty: 0,
                    unit: state.products.find(p=>p.id===it.productId)?.unit || '個',
                    buyers: new Set()
                };
            }
            stats[it.productId].totalQty += it.quantity;
            stats[it.productId].buyers.add(o.customerId);
        });
    });
    const list = Object.values(stats).sort((a, b) => a.id.localeCompare(b.id, undefined, {numeric: true}));
    const html = list.map(s => {
        const stock = stockFor(state.activeGroupBuyId, s.id);
        return `
            <tr>
                <td style="font-family: Outfit; font-weight:700;"><span class="badge badge-id">${escapeHtml(s.id)}</span></td>
                <td style="font-weight:700;">${escapeHtml(s.name)}</td>
                <td>${escapeHtml(s.specs || '-')}</td>
                <td style="font-size:18px; font-weight:900; color:var(--primary-orange);">${s.totalQty}</td>
                <td>${stock?.stockEnabled ? stock.sellableQuantity : '不限量'}</td>
                <td>${stock?.stockEnabled ? stock.soldQuantity : s.totalQty}</td>
                <td>${stock?.stockEnabled ? stock.remainingQuantity : '—'}</td>
                <td>${stockStatusBadge(stock)}</td>
                <td style="font-weight:700;">${escapeHtml(s.unit)}</td>
                <td style="font-weight:700;">${s.buyers.size} 人</td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="viewProductBuyers('${s.id}')"><i class="fa-solid fa-list-check"></i> 查看名單</button>
                </td>
            </tr>
        `;
    }).join('');
    tbody.innerHTML = html || `<tr><td colspan="11" style="text-align:center; color:var(--text-muted);">本團尚無商品統計</td></tr>`;
}

// 檢視哪些客戶購買了該商品
function viewProductBuyers(prodId) {
    const prod = state.products.find(p => p.id === prodId);
    document.getElementById('product-buyers-title').textContent = prod 
        ? `[${prod.id}] ${prod.name} - 訂購名單` 
        : "商品訂購名單";

    const tbody = document.getElementById('product-buyers-tbody');
    let html = "";

    // 找出本活動所有購買此商品的訂單
    const activeOrders = state.orders.filter(o => o.groupBuyId === state.activeGroupBuyId && o.orderStatus !== "已取消");

    activeOrders.forEach(o => {
        const it = o.items.find(x => x.productId === prodId);
        if (it) {
            const isItChecked = o.checkedProductIds && o.checkedProductIds.includes(prodId);
            html += `
                <tr>
                    <td style="font-family: Outfit; font-weight:700;">${escapeHtml(o.customerId)}</td>
                    <td style="font-weight:700;">${escapeHtml(orderCustomerName(o))}</td>
                    <td><span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span></td>
                    <td style="font-weight:900; color:var(--primary-orange);">${it.quantity}</td>
                    <td style="font-weight:700;">NT$ ${it.price * it.quantity}</td>
                    <td><span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span></td>
                    <td>${isItChecked ? '<span class="badge badge-paid"><i class="fa-solid fa-check-circle"></i> 已包</span>' : '<span class="badge badge-unpaid">未包</span>'}</td>
                </tr>
            `;
        }
    });

    tbody.innerHTML = html;
    openModal('product-buyers-modal');
}


// ==========================================================================
// 8. Excel 匯入 / 匯出邏輯 (重點模組)
// ==========================================================================
function prepareExcelExport() {
    document.getElementById('export-filter-pickup').value = "all";
    document.getElementById('export-filter-payment').value = "all";
    document.getElementById('export-filter-status').value = "all";
    renderCurrentGroupBuySelect();
    pendingExcelOrderImport = null;
    const confirmButton = document.getElementById('excel-import-confirm');
    if (confirmButton) confirmButton.disabled = true;
    const preview = document.getElementById('excel-import-preview');
    if (preview) preview.innerHTML = '';
}

async function onExcelGroupChange(groupBuyId) {
    await Promise.all([loadGroupBuyStock(groupBuyId), loadInventoryMovements(groupBuyId)]);
}

function excelValue(row, names) {
    for (const name of names) {
        if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return row[name];
    }
    return '';
}

function readExcelOrderRows(file) {
    return file.arrayBuffer().then(buffer => {
        const workbook = XLSX.read(buffer, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!firstSheet) throw new Error('Excel 沒有可讀取的工作表');
        return XLSX.utils.sheet_to_json(firstSheet, { defval: '' }).map(row => ({
            customerId: String(excelValue(row, ['客戶編號', 'customerId', 'customer_id'])).trim(),
            productId: String(excelValue(row, ['商品編號', 'productId', 'product_id'])).trim(),
            quantity: Number(excelValue(row, ['數量', 'quantity'])),
            pickupType: String(excelValue(row, ['取貨方式', 'pickupType', 'pickup_type']) || '自取').trim(),
            unitPrice: excelValue(row, ['單價', 'unitPrice', 'unit_price']) === ''
                ? undefined : Number(excelValue(row, ['單價', 'unitPrice', 'unit_price']))
        }));
    });
}

function excelStockStatusLabel(status) {
    return ({
        ready: '可匯入',
        insufficient_stock: '庫存不足',
        stock_not_enabled: '商品未啟用庫存控管',
        sold_out: '商品已售完'
    })[status] || status;
}

async function previewExcelOrderImport() {
    const file = document.getElementById('excel-import-file').files[0];
    const groupBuyId = document.getElementById('excel-import-group-select').value;
    const previewNode = document.getElementById('excel-import-preview');
    const confirmButton = document.getElementById('excel-import-confirm');
    pendingExcelOrderImport = null;
    confirmButton.disabled = true;
    if (!file || !groupBuyId) return alert('請先選擇團購活動與 Excel 檔案。');
    try {
        const rows = await readExcelOrderRows(file);
        if (!rows.length) throw new Error('Excel 沒有訂單資料');
        const payload = { groupBuyId, rows };
        const result = await cloudFetch('/api/orders/import/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (result.error || result.skipped) throw new Error(result.error || '尚未設定後台 API 金鑰');
        const checks = result.data.stockChecks || [];
        previewNode.innerHTML = `<table class="table-custom">
            <thead><tr><th>商品</th><th>目前剩餘</th><th>本次增加</th><th>不足</th><th>狀態</th></tr></thead>
            <tbody>${checks.map(check => `<tr>
                <td>${escapeHtml(check.productCode)}｜${escapeHtml(check.productName)}</td>
                <td>${check.stockEnabled ? check.remainingQuantity : '不限量'}</td>
                <td>${check.requestedIncrease}</td>
                <td>${check.shortageQuantity}</td>
                <td>${excelStockStatusLabel(check.status)}</td>
            </tr>`).join('')}</tbody></table>
            <p class="page-subtitle">共 ${result.data.orderCount} 張訂單、${result.data.rowCount} 個商品彙總。預覽尚未扣庫存。</p>`;
        pendingExcelOrderImport = result.data.valid ? payload : null;
        confirmButton.disabled = !result.data.valid;
    } catch (error) {
        previewNode.innerHTML = `<div class="notice notice-danger">${escapeHtml(error.message)}</div>`;
    }
}

async function confirmExcelOrderImport() {
    if (!pendingExcelOrderImport || !confirm('確定正式匯入？系統會重新檢查庫存，任一商品不足時整批不寫入。')) return;
    const payload = { ...pendingExcelOrderImport, requestId: `excel-${crypto.randomUUID()}` };
    const result = await cloudFetch('/api/orders/import/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (result.error || result.skipped) {
        alert(`匯入失敗：${result.error || '尚未設定後台 API 金鑰'}\n未產生半套訂單。`);
        return;
    }
    await Promise.all([
        syncLineOrdersFromCloud(payload.groupBuyId),
        loadGroupBuyStock(payload.groupBuyId),
        loadInventoryMovements(payload.groupBuyId)
    ]);
    pendingExcelOrderImport = null;
    document.getElementById('excel-import-confirm').disabled = true;
    saveStateToStorage();
    alert(result.data.duplicate ? '這批資料先前已匯入，未重複扣庫存。' : `正式匯入完成：${result.data.importedOrders} 張訂單。`);
}

function buildProductInventoryExportRows(gbId) {
    const groupBuy = state.groupBuys.find(g => g.id === gbId);
    const inventoryOrders = state.orders.filter(o => o.groupBuyId === gbId && o.orderStatus !== '已取消');
    const stats = {};
    groupBuyProducts(groupBuy).forEach(product => {
        stats[product.id] = { product, totalQuantity: 0, buyers: new Set() };
    });
    inventoryOrders.forEach(order => {
        (order.items || []).forEach(item => {
            if (!stats[item.productId]) {
                stats[item.productId] = {
                    product: state.products.find(product => product.id === item.productId) || {
                        id: item.productId,
                        name: item.productName,
                        specs: item.specs || '',
                        unit: item.unit || '個'
                    },
                    totalQuantity: 0,
                    buyers: new Set()
                };
            }
            stats[item.productId].totalQuantity += Number(item.quantity) || 0;
            stats[item.productId].buyers.add(order.customerId);
        });
    });
    return Object.values(stats).map(entry => {
        const product = entry.product;
        const stock = stockFor(gbId, product.id);
        const cancellationReplenished = state.inventoryMovements
            .filter(movement => movement.group_buy_id === gbId
                && movement.product_id === product.id
                && movement.movement_type === 'order_cancelled')
            .reduce((sum, movement) => sum + Math.max(0, Number(movement.quantity_change) || 0), 0);
        return {
            "商品編號": product.id,
            "商品名稱": product.name,
            "規格": product.specs || "",
            "進貨數量": stock?.stockEnabled ? stock.incomingQuantity : "",
            "保留數量": stock?.stockEnabled ? stock.reservedQuantity : "",
            "可賣數量": stock?.stockEnabled ? stock.sellableQuantity : "不限量",
            "已售數量": stock?.stockEnabled ? stock.soldQuantity : entry.totalQuantity,
            "取消回補數量": cancellationReplenished,
            "剩餘數量": stock?.stockEnabled ? stock.remainingQuantity : "",
            "低庫存門檻": stock?.stockEnabled ? stock.lowStockThreshold : "",
            "庫存狀態": stockStatusLabel(stock),
            "購買客戶數": entry.buyers.size
        };
    }).sort((a, b) => a["商品編號"].localeCompare(b["商品編號"], undefined, {numeric: true}));
}

// --- Excel 匯出模組 (支援多工作表) ---
function exportToExcel() {
    const gbId = document.getElementById('export-group-select').value;
    const pickupFilter = document.getElementById('export-filter-pickup').value;
    const paymentFilter = document.getElementById('export-filter-payment').value;
    const statusFilter = document.getElementById('export-filter-status').value;

    const gb = state.groupBuys.find(g => g.id === gbId);
    if (!gb) {
        alert("請選擇欲匯出的團購活動！");
        return;
    }

    // 篩選訂單
    let list = state.orders.filter(o => o.groupBuyId === gbId);

    // 套用篩選器
    if (pickupFilter !== 'all') {
        list = list.filter(o => o.pickupType === pickupFilter);
    }
    if (paymentFilter !== 'all') {
        list = list.filter(o => o.paymentStatus === paymentFilter);
    }
    if (statusFilter === 'all') {
        // 不含已取消
        list = list.filter(o => o.orderStatus !== '已取消');
    } else if (statusFilter === 'all-with-cancelled') {
        // 包含已取消
    } else if (statusFilter === '已包貨') {
        list = list.filter(o => o.orderStatus === '已包貨');
    } else if (statusFilter === '未包貨') {
        list = list.filter(o => o.orderStatus === '新訂單' || o.orderStatus === '已確認');
    } else if (statusFilter === '已完成') {
        list = list.filter(o => o.orderStatus === '已完成');
    }

    // 依客戶編號自然排序
    list.sort((a, b) => a.customerId.localeCompare(b.customerId, undefined, {numeric: true}));

    if (list.length === 0 && groupBuyProducts(gb).length === 0) {
        alert("目前選定的團購沒有商品或訂單資料可匯出！");
        return;
    }

    // 1. 建立「客戶訂購總表」
    const dataSheet1 = list.map(o => {
        const prodSummary = o.items.map(it => `${it.productName}(${it.specs})x${it.quantity}`).join('、');
        const totalItemsCount = o.items.reduce((s, it) => s + it.quantity, 0);
        return {
            "客戶編號": o.customerId,
            "客戶暱稱": orderCustomerName(o),
            "連絡電話": o.phone,
            "配送地址": o.pickupType === "外送" ? o.address : "自取",
            "取貨方式": o.pickupType,
            "商品種類": o.items.length,
            "商品總件數": totalItemsCount,
            "訂單總額": effectiveOrderTotal(o),
            "付款狀態": o.paymentStatus,
            "訂單狀態": o.orderStatus
        };
    });

    // 2. 建立「客戶商品明細」
    const dataSheet2 = [];
    list.forEach(o => {
        o.items.forEach(it => {
            const unitPrice = effectiveUnitPrice(it, o.pickupType);
            dataSheet2.push({
                "客戶編號": o.customerId,
                "客戶暱稱": orderCustomerName(o),
                "商品編號": it.productId,
                "商品名稱": it.productName,
                "規格": it.specs || "",
                "數量": it.quantity,
                "取貨方式": o.pickupType || "",
                "單價": unitPrice,
                "小計": unitPrice * it.quantity
            });
        });
    });

    // 3. 建立「商品數量統計」；庫存數字固定採有效訂單，不受上方匯出篩選條件影響。
    const dataSheet3 = buildProductInventoryExportRows(gbId);

    // 4. 建立「外送及自取名單」
    const dataSheet4 = list.map(o => ({
        "客戶編號": o.customerId,
        "客戶暱稱": orderCustomerName(o),
        "連絡電話": o.phone,
        "配送地址": o.pickupType === "外送" ? o.address : "",
        "取貨方式": o.pickupType,
        "訂單總額": effectiveOrderTotal(o),
        "備註說明": o.notes || ""
    }));

    // 利用 SheetJS 彙整工作簿
    const wb = XLSX.utils.book_new();

    const ws1 = XLSX.utils.json_to_sheet(dataSheet1);
    XLSX.utils.book_append_sheet(wb, ws1, "客戶訂購總表");

    const ws2 = XLSX.utils.json_to_sheet(dataSheet2);
    XLSX.utils.book_append_sheet(wb, ws2, "客戶商品明細");

    const ws3 = XLSX.utils.json_to_sheet(dataSheet3);
    XLSX.utils.book_append_sheet(wb, ws3, "商品數量統計");

    const ws4 = XLSX.utils.json_to_sheet(dataSheet4);
    XLSX.utils.book_append_sheet(wb, ws4, "外送及自取名單");

    // 產出檔名：阿賢Easy購_團購名稱_訂單彙整_日期.xlsx
    const today = new Date().toISOString().split('T')[0];
    const fileName = `阿賢Easy購_${gb.name.replace(/[\/\s\?]/g, '')}_訂單彙整_${today}.xlsx`;

    XLSX.writeFile(wb, fileName);
    alert("Excel 報表匯出成功！已自動開始下載。");
}


// ==========================================================================
// 9. 通用 Modal 控制與其他輔助工具
// ==========================================================================
function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('show');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('show');
}

// ==========================================================================
// 10. LINE 完全靜默收單後台（僅讀取與人工轉單，不含任何發訊功能）
// ==========================================================================
const API_BASE_URL = 'https://ah-hsien-easy-buy-line.vannyai.workers.dev';

function getLineApiBase() {
    return API_BASE_URL;
}

function renderLineSettings() {
    const input = document.getElementById('line-api-base');
    if (input) input.value = getLineApiBase();
    const keyInput = document.getElementById('line-admin-api-key');
    if (keyInput) keyInput.value = localStorage.getItem('easygo_line_admin_api_key') || '';
}

function saveLineSettings() {
    const apiKey = document.getElementById('line-admin-api-key').value.trim();
    localStorage.removeItem('easygo_line_api_base');
    localStorage.setItem('easygo_line_admin_api_key', apiKey);
    alert('LINE 後台連線設定已儲存。靜默模式維持強制啟用。');
}

function escapeLineText(value) {
    return escapeHtml(value);
}

// LINE 收件匣：支援「P023 A+3」、更正與取消命令。
// 把商品卡 Postback 的原始參數轉成人看得懂的文字（相容既有舊紀錄）
function friendlyPostbackText(value) {
    const text = String(value || '');
    if (!/^action=/.test(text)) return text;
    const params = new URLSearchParams(text);
    const product = params.get('productId') || '';
    switch (params.get('action')) {
        case 'set_quantity': return `商品卡：${product} 設為 ${params.get('quantity')} 份`;
        case 'cancel_item': return `商品卡：取消 ${product}`;
        case 'view_order': return `商品卡：查看訂單`;
        default: return text;
    }
}

function renderLineInbox() {
    const tbody = document.getElementById('line-inbox-tbody');
    if (!tbody) return;
    if (!state.lineInbox.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">尚無 LINE 收件資料。</td></tr>';
        return;
    }
    tbody.innerHTML = state.lineInbox.map(row => {
        let items = row.parsed_items || row.parsedItems || [];
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_error) { items = []; } }
        const status = row.status || '待處理';
        const action = row.action || 'create';
        const actionLabels = { create: '新增', replace: '更正', cancel: '取消' };
        const customerId = row.customer_id || row.customerId;
        let stockInsufficient = false;
        const itemText = items.length
            ? items.map(item => {
                const stock = Object.values(state.groupBuyStock).find(value =>
                    value.groupBuyId === state.activeGroupBuyId
                    && (value.productCode === item.productCode || value.productId === item.productCode));
                if (!stock?.stockEnabled) return `${escapeLineText(item.productCode)} × ${Number(item.quantity)}<small>未啟用數量限制</small>`;
                const order = state.orders.find(value => value.groupBuyId === state.activeGroupBuyId
                    && value.customerId === customerId && value.orderStatus !== '已取消');
                const before = Number(order?.items?.find(value =>
                    value.productId === stock.productId)?.quantity || 0);
                const desired = action === 'cancel' ? 0 : Number(item.quantity);
                const delta = action === 'create' ? desired : desired - before;
                const after = Number(stock.remainingQuantity) - delta;
                if (after < 0) stockInsufficient = true;
                return `${escapeLineText(item.productCode)} × ${Number(item.quantity)}
                    <small>目前剩餘 ${stock.remainingQuantity}；轉入後 ${Math.max(0, after)}</small>`;
            }).join('<br>')
            : escapeLineText(row.target_product_prefix || '');
        const canImport = status === '可匯入' && Boolean(customerId) && !stockInsufficient;
        const messageIdEncoded = encodeURIComponent(row.message_id || row.messageId);
        const hasCustomer = Boolean(row.customer_id || row.customerId);
        const hasLineUser = Boolean(row.line_user_id || row.lineUserId);
        const customerCell = hasCustomer
            ? `${escapeLineText(row.customer_id || row.customerId)}<small>${escapeLineText(row.customer_display_name || row.customer_nickname || row.customerNickname)}</small>`
            : (hasLineUser
                ? `<button class="btn btn-secondary btn-sm" onclick="openLineBindModal('${messageIdEncoded}', '${escapeLineText(row.display_name || row.displayName)}')"><i class="fa-solid fa-link"></i> 綁定客戶</button>`
                : '<small>無 LINE ID</small>');
        return `<tr>
            <td><strong>${escapeLineText(row.display_name || row.displayName)}</strong><small>${escapeLineText(row.line_user_id || row.lineUserId)}</small></td>
            <td>${customerCell}</td>
            <td><span class="line-action line-action-${escapeLineText(action)}">${actionLabels[action] || action}</span><br>${escapeLineText(friendlyPostbackText(row.raw_message || row.rawMessage))}</td>
            <td>${escapeLineText(friendlyPostbackText(row.normalized_message || row.normalizedMessage))}</td>
            <td>${itemText}</td>
            <td>${escapeLineText(row.pickup_type || row.pickupType)}</td><td>${escapeLineText(row.message_time || row.messageTime)}</td>
            <td><span class="line-status">${escapeLineText(stockInsufficient ? '庫存不足' : status)}</span></td><td>${escapeLineText(row.error_reason || row.errorReason)}</td>
            <td><button class="btn btn-primary btn-sm" ${canImport ? '' : 'disabled'} onclick="importLineInbox('${encodeURIComponent(row.message_id || row.messageId)}')">${action === 'cancel' ? '確認取消' : action === 'replace' ? '確認更正' : '轉正式訂單'}</button></td>
        </tr>`;
    }).join('');
}

function setLineInboxBusy(busy) {
    const btn = document.getElementById('line-inbox-refresh');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
        ? '<i class="fa-solid fa-rotate fa-spin"></i> 更新中…'
        : '<i class="fa-solid fa-rotate"></i> 重新整理';
}

function setLineInboxStamp(message) {
    const stamp = document.getElementById('line-inbox-updated');
    if (stamp) stamp.textContent = message;
}

async function loadLineInbox() {
    const base = getLineApiBase();
    if (!base) {
        state.lineInbox = [];
        renderLineInbox();
        setLineInboxStamp('尚未設定 Worker API 網址');
        return;
    }
    setLineInboxBusy(true);
    setLineInboxStamp('更新中…');
    try {
        // 加時間戳 + no-store：避免瀏覽器/CDN 回舊快取，導致按了重新整理卻看不到新留言。
        const response = await fetch(`${base}/api/line-inbox?t=${Date.now()}`, {
            cache: 'no-store',
            headers: { authorization: `Bearer ${localStorage.getItem('easygo_line_admin_api_key') || ''}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.lineInbox = await response.json();
        await loadGroupBuyStock(state.activeGroupBuyId);
        renderLineInbox();
        const now = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        setLineInboxStamp(`已更新 ${now}（${state.lineInbox.length} 筆）`);
    } catch (error) {
        state.lineInbox = [];
        renderLineInbox();
        setLineInboxStamp('更新失敗');
        alert(`無法讀取 LINE 訂單收件匣：${error.message}`);
    } finally {
        setLineInboxBusy(false);
    }
}

async function importLineInbox(encodedMessageId) {
    if (!confirm('確定要處理這筆 LINE 收件資料嗎？')) return;
    const response = await fetch(`${getLineApiBase()}/api/line-inbox/${encodedMessageId}/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${localStorage.getItem('easygo_line_admin_api_key') || ''}` }
    });
    const result = await response.json();
    if (!response.ok) {
        alert(`${result.message || result.error || '處理失敗'}${result.remainingQuantity == null ? '' : `\n目前剩餘：${result.remainingQuantity}`}`);
        return;
    }
    await loadLineInbox();
    alert(result.imported ? '處理完成。' : '這筆資料先前已處理。');
}

// --- 收件匣：一鍵綁定客戶 ---
let lineBindTargetMessageId = '';

function openLineBindModal(encodedMessageId, displayName) {
    if (!state.customers.length) {
        alert('目前沒有客戶資料，請先到「客戶管理」新增客戶！');
        return;
    }
    lineBindTargetMessageId = encodedMessageId;
    const select = document.getElementById('line-bind-customer-select');
    const sorted = [...state.customers].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    select.innerHTML = sorted.map(c => `<option value="${escapeLineText(c.id)}">${escapeLineText(c.id)}｜${escapeLineText(customerDisplayName(c))}${c.phone ? `（${escapeLineText(c.phone)}）` : ''}</option>`).join('');
    document.getElementById('line-bind-display-name').textContent = displayName || '(未知名稱)';
    document.getElementById('line-bind-modal').classList.add('show');
}

function closeLineBindModal() {
    lineBindTargetMessageId = '';
    document.getElementById('line-bind-modal').classList.remove('show');
}

async function confirmLineBind() {
    const customerId = document.getElementById('line-bind-customer-select').value;
    const customer = state.customers.find(c => c.id === customerId);
    if (!customer || !lineBindTargetMessageId) return;
    const response = await fetch(`${getLineApiBase()}/api/line-inbox/${lineBindTargetMessageId}/bind-customer`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${localStorage.getItem('easygo_line_admin_api_key') || ''}`
        },
        // nickname 送的是團主自訂名稱（存進 custom_display_name），LINE 原始名稱由 Webhook 維護。
        body: JSON.stringify({
            customer_id: customer.id,
            nickname: customer.customDisplayName != null ? customer.customDisplayName : (customer.nickname || '')
        })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        alert(result.error || '綁定失敗');
        return;
    }
    closeLineBindModal();
    // 綁定後把雲端客戶（含 LINE 原始名稱）拉回本機，客戶管理才看得到 LINE 名稱提示
    await syncCustomersFromCloud();
    await loadLineInbox();
    alert(`綁定完成！${customer.id}｜${result.customer_display_name || customerDisplayName(customer)}，共回填 ${result.updated_messages} 則訊息。之後這位客戶的留言會自動配對。`);
}
