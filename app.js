/* ==========================================================================
   阿賢Easy購管理系統 - 核心邏輯 & 資料控制 (app.js)
   ========================================================================== */

// --- 系統資料狀態庫 ---
let state = {
    groupBuys: [],
    products: [],
    customers: [],
    orders: [],
    lineInbox: [],
    activeGroupBuyId: "" // 當前選取的團購活動 ID
};

// --- 繁體中文示範資料 ---
const DEMO_DATA = {
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
    } else {
        // 載入示範資料
        state.groupBuys = JSON.parse(JSON.stringify(DEMO_DATA.groupBuys));
        state.products = JSON.parse(JSON.stringify(DEMO_DATA.products));
        state.customers = JSON.parse(JSON.stringify(DEMO_DATA.customers));
        state.orders = JSON.parse(JSON.stringify(DEMO_DATA.orders));
        state.activeGroupBuyId = "GB001";
        saveStateToStorage();
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

// 清除/重設資料庫
function resetDatabaseToDemo() {
    if (confirm("您確定要將系統回復到初始的繁體中文示範資料嗎？現有資料將被覆蓋！")) {
        localStorage.clear();
        initDatabase();
        renderCurrentGroupBuySelect();
        switchView(currentViewId);
        alert("系統資料已成功重置為示範資料！");
    }
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
    } else if (viewId === 'group-buys') {
        renderGroupBuys();
    } else if (viewId === 'line-inbox') {
        loadLineInbox();
    } else if (viewId === 'line-settings') {
        renderLineSettings();
    } else if (viewId === 'orders') {
        if (subviewAction === 'by-customer') {
            toggleOrderViewMode('by-customer');
        } else if (subviewAction === 'by-product') {
            toggleOrderViewMode('by-product');
        } else {
            toggleOrderViewMode('list');
        }
    } else if (viewId === 'customers') {
        renderCustomers();
    } else if (viewId === 'products') {
        renderProducts();
    } else if (viewId === 'excel') {
        // 2026-07-20 匯入功能下架（訂單以 LINE 訂單收件匣為主），一律顯示匯出
        toggleExcelSubtab('export');
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
    
    let html = "";
    // 依狀態排序：開放 -> 截止 -> 完成
    const sortedGB = [...state.groupBuys].sort((a, b) => {
        const order = { "開放": 1, "截止": 2, "完成": 3 };
        return order[a.status] - order[b.status];
    });

    sortedGB.forEach(gb => {
        const isSelected = gb.id === state.activeGroupBuyId ? "selected" : "";
        html += `<option value="${gb.id}" ${isSelected}>[${gb.status}] ${gb.name}</option>`;
    });

    if (select) select.innerHTML = html;
    if (selectExport) selectExport.innerHTML = html;
}


// ==========================================================================
// 1. 首頁 (Dashboard) 邏輯
// ==========================================================================
function renderDashboard() {
    const activeGb = state.groupBuys.find(g => g.id === state.activeGroupBuyId);
    const title = document.getElementById('dashboard-title');
    if (title) {
        title.innerHTML = activeGb 
            ? `${activeGb.name} <span class="badge ${activeGb.status === '開放' ? 'badge-group-open' : activeGb.status === '截止' ? 'badge-group-closed' : 'badge-group-completed'}">${activeGb.status}</span>`
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
                <td><span class="badge badge-id" style="margin-right:6px;">${o.customerId}</span>${o.customerNickname}</td>
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
                <td><span class="badge badge-id" style="margin-right:6px;">${o.customerId}</span>${o.customerNickname}</td>
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
                <td style="font-weight:700;">${isCurrent}${gb.name}</td>
                <td style="font-family: Outfit;">${gb.startDate || '-'}</td>
                <td style="font-family: Outfit;">${gb.endDate || '-'}</td>
                <td><span class="badge ${gb.status === '開放' ? 'badge-group-open' : gb.status === '截止' ? 'badge-group-closed' : 'badge-group-completed'}">${gb.status}</span></td>
                <td style="font-size:13px; color:var(--text-muted);">${gb.notes || ''}</td>
                <td>
                    <div class="button-group">
                        <button class="btn btn-secondary btn-sm" onclick="openGroupBuyModal('${gb.id}')"><i class="fa-solid fa-edit"></i> 編輯</button>
                        <button class="btn btn-secondary btn-sm" onclick="selectGroupBuyDirectly('${gb.id}')"><i class="fa-solid fa-circle-check"></i> 選定</button>
                        <button class="btn btn-teal btn-sm" onclick="copyProductsFromPreviousGroup('${gb.id}')" title="複製前一團的商品列表"><i class="fa-solid fa-copy"></i> 複製前團商品</button>
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
    alert("已切換目前選定之團購活動！");
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
function openGroupBuyModal(id = '') {
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
        }
    } else {
        title.textContent = "新增團購活動";
        document.getElementById('gb-status').value = "開放";
        document.getElementById('gb-start-date').value = new Date().toISOString().split('T')[0];
    }
    modal.classList.add('show');
}

function closeGroupBuyModal() {
    document.getElementById('group-buy-modal').classList.remove('show');
}

function saveGroupBuy() {
    const id = document.getElementById('group-buy-id').value;
    const name = document.getElementById('gb-name').value.trim();
    const startDate = document.getElementById('gb-start-date').value;
    const endDate = document.getElementById('gb-end-date').value;
    const status = document.getElementById('gb-status').value;
    const notes = document.getElementById('gb-notes').value.trim();

    if (!name) {
        alert("請輸入團購活動名稱！");
        return;
    }

    if (id) {
        // 編輯
        const gb = state.groupBuys.find(g => g.id === id);
        if (gb) {
            gb.name = name;
            gb.startDate = startDate;
            gb.endDate = endDate;
            gb.status = status;
            gb.notes = notes;
        }
    } else {
        // 新增
        const newId = "GB" + String(state.groupBuys.length + 1).padStart(3, '0');
        state.groupBuys.push({ id: newId, name, startDate, endDate, status, notes });
        if (state.groupBuys.length === 1) {
            state.activeGroupBuyId = newId;
        }
    }

    saveStateToStorage();
    renderCurrentGroupBuySelect();
    closeGroupBuyModal();
    renderGroupBuys();
    if (currentViewId === 'dashboard') renderDashboard();
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
        const statusBadge = p.enabled 
            ? `<span class="badge badge-paid">啟用中</span>` 
            : `<span class="badge badge-unpaid">已停用</span>`;

        html += `
            <tr>
                <td style="font-family: Outfit; font-weight: 700;">${p.id}</td>
                <td><div style="width:40px; height:40px; border-radius:8px; background-color:var(--bg-warm-gray); display:flex; align-items:center; justify-content:center; color:var(--text-muted);"><i class="fa-solid fa-image"></i></div></td>
                <td style="font-weight:700;">${p.name}</td>
                <td>${p.specs || '-'}</td>
                <td style="font-weight:700; color:var(--primary-orange);">NT$ ${p.price}</td>
                <td>${p.unit}</td>
                <td>${statusBadge}</td>
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
                    <span class="mobile-card-title"><span class="badge badge-id">${p.id}</span> ${p.name}</span>
                    <span>${statusBadge}</span>
                </div>
                <div class="mobile-card-divider"></div>
                <div class="mobile-card-row">
                    <span style="color:var(--text-muted);">規格：${p.specs || '-'}</span>
                    <span style="font-weight:700; color:var(--primary-orange);">NT$ ${p.price} / ${p.unit}</span>
                </div>
                <div class="mobile-card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="openProductModal('${p.id}')"><i class="fa-solid fa-edit"></i> 編輯</button>
                    <button class="btn btn-secondary btn-sm" onclick="toggleProductStatus('${p.id}')">${p.enabled ? '停用' : '啟用'}</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')" ${isUsed ? 'disabled' : ''}><i class="fa-solid fa-trash"></i> 刪除</button>
                </div>
            </div>
        `;
    });

    tbody.innerHTML = html || `<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">無商品資料</td></tr>`;
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
            document.getElementById('prod-unit').value = p.unit;
            document.getElementById('prod-enabled').value = String(p.enabled);
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

function saveProduct() {
    const id = document.getElementById('prod-id').value.trim().toUpperCase();
    const name = document.getElementById('prod-name').value.trim();
    const specs = document.getElementById('prod-specs').value.trim();
    const priceVal = document.getElementById('prod-price').value;
    const unit = document.getElementById('prod-unit').value.trim();
    const enabled = document.getElementById('prod-enabled').value === "true";
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

    const existingIdx = state.products.findIndex(p => p.id === id);
    const isEdit = document.getElementById('prod-id').readOnly;

    if (!isEdit && existingIdx > -1) {
        alert(`商品編號 ${id} 已存在，請使用其他編號！`);
        return;
    }

    if (isEdit) {
        // 編輯
        if (existingIdx > -1) {
            state.products[existingIdx] = { id, name, specs, price, unit, enabled, photo };
        }
    } else {
        // 新增
        state.products.push({ id, name, specs, price, unit, enabled, photo });
    }

    saveStateToStorage();
    closeProductModal();
    renderProducts();
    alert("商品資料儲存成功！");
}

function toggleProductStatus(id) {
    const p = state.products.find(x => x.id === id);
    if (p) {
        p.enabled = !p.enabled;
        saveStateToStorage();
        renderProducts();
        alert(`已成功將商品 ${id} 狀態切換為：${p.enabled ? '啟用' : '停用'}`);
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
        alert("商品已刪除！");
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
            c.nickname.toLowerCase().includes(s) || 
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
                <td style="font-family: Outfit; font-weight:700;"><span class="badge badge-id">${c.id}</span></td>
                <td style="font-weight:700;">${c.nickname}</td>
                <td style="font-family: Outfit;">${c.phone}</td>
                <td style="font-size:13px;">${c.address || '<span style="color:var(--text-muted);">自取客戶/無地址</span>'}</td>
                <td style="font-size:13px; color:var(--text-muted);">${c.notes || ''}</td>
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
                    <span class="mobile-card-title"><span class="badge badge-id">${c.id}</span> ${c.nickname}</span>
                    <span style="font-family:Outfit; font-weight:500;">${c.phone}</span>
                </div>
                <div class="mobile-card-divider"></div>
                <div style="font-size:13px; color:var(--text-dark);">
                    <i class="fa-solid fa-location-dot" style="color:var(--primary-coral); width:16px;"></i> ${c.address || '無外送地址 (自取)'}
                </div>
                <div style="font-size:13px; color:var(--text-muted);">
                    <i class="fa-solid fa-note-sticky" style="width:16px;"></i> 備註：${c.notes || '無'}
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
            duplicates.push(`電話與客戶 [${c.id} ${c.nickname}] 重複`);
        }

        // 規則 3：暱稱且地址完全相同
        if (nickname && address && c.nickname === nickname && c.address === address) {
            duplicates.push(`暱稱與地址與客戶 [${c.id} ${c.nickname}] 相同`);
        }
    });

    if (duplicates.length > 0) {
        alertMsg.innerHTML = `<strong>重複提醒：</strong>` + duplicates.join('、') + "，請確認是否為重複建檔！";
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
            document.getElementById('cust-nickname').value = c.nickname;
            document.getElementById('cust-phone').value = c.phone;
            document.getElementById('cust-address').value = c.address;
            document.getElementById('cust-notes').value = c.notes;
        }
    } else {
        title.textContent = "新增客戶";
        document.getElementById('customer-edit-mode').value = "create";
        autoGenerateCustId();
    }
    modal.classList.add('show');
}

function closeCustomerModal() {
    document.getElementById('customer-modal').classList.remove('show');
}

function saveCustomer() {
    const id = document.getElementById('cust-id').value.trim().toUpperCase();
    const nickname = document.getElementById('cust-nickname').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();
    const address = document.getElementById('cust-address').value.trim();
    const notes = document.getElementById('cust-notes').value.trim();
    const editMode = document.getElementById('customer-edit-mode').value;

    if (!id || !nickname || !phone) {
        alert("請輸入客戶編號、暱稱與連絡電話！");
        return;
    }

    const existingIdx = state.customers.findIndex(c => c.id === id);

    if (editMode === 'create' && existingIdx > -1) {
        alert(`客戶編號 ${id} 已存在，請使用其他編號或自動推算！`);
        return;
    }

    if (editMode === 'edit') {
        if (existingIdx > -1) {
            state.customers[existingIdx] = { id, nickname, phone, address, notes };
            
            // 同步更新當前團購活動訂單中的冗餘資訊
            state.orders.forEach(o => {
                if (o.customerId === id) {
                    o.customerNickname = nickname;
                    o.phone = phone;
                    // 自取不覆蓋地址，外送若無自訂地址則可更新
                    if (o.pickupType === "外送" && !o.address) {
                        o.address = address;
                    }
                }
            });
        }
    } else {
        state.customers.push({ id, nickname, phone, address, notes });
    }

    saveStateToStorage();
    closeCustomerModal();
    renderCustomers();
    if (currentViewId === 'dashboard') renderDashboard();
    alert("客戶資料儲存成功！");
}

function deleteCustomer(id) {
    const hasHistory = state.orders.some(o => o.customerId === id);
    if (hasHistory) {
        alert("此客戶已有訂單紀錄，不可永久刪除，以維護訂單交易歷史！");
        return;
    }

    if (confirm(`確定要永久刪除客戶「${id} ｜ ${state.customers.find(c=>c.id===id).nickname}」嗎？`)) {
        state.customers = state.customers.filter(c => c.id !== id);
        saveStateToStorage();
        renderCustomers();
        alert("客戶已刪除！");
    }
}

// 檢視客戶購買歷史歷史明細
function viewCustomerHistory(id) {
    const c = state.customers.find(x => x.id === id);
    if (!c) return;

    document.getElementById('cust-history-title').textContent = `[${c.id}] ${c.nickname} 歷史訂購統計`;
    const tbody = document.getElementById('cust-history-tbody');
    
    // 找出所有此客戶的訂單
    const custOrders = state.orders.filter(o => o.customerId === id).sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));

    let html = "";
    custOrders.forEach(o => {
        const gb = state.groupBuys.find(g => g.id === o.groupBuyId);
        const gbName = gb ? gb.name : "未知團購";

        let itemStr = o.items.map(it => `${it.productName} (${it.specs}) x ${it.quantity}`).join('<br>');

        html += `
            <tr>
                <td style="font-size:13px; font-weight:700;">${gbName}</td>
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
            o.customerNickname.toLowerCase().includes(s) || 
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
        
        if (sortVal === "cust-name-asc") return a.customerNickname.localeCompare(b.customerNickname, "zh-Hant-TW");
        
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
        const itemStr = o.items.map(it => `<div style="font-size:13px; line-height:1.4;">${it.productName} <span style="color:var(--text-muted);">(${it.specs || '無規格'})</span> <strong>x ${it.quantity}</strong></div>`).join('');
        
        // 地址或配送說明
        let deliveryInfo = "";
        if (o.pickupType === "外送") {
            deliveryInfo = `<div style="font-size:12px; color:var(--text-muted);"><i class="fa-solid fa-map-marker-alt" style="color:var(--primary-coral);"></i> ${o.address || '無外送地址'}</div>`;
        } else {
            deliveryInfo = `<div style="font-size:12px; color:var(--primary-teal);"><i class="fa-solid fa-house-user"></i> 自取</div>`;
        }

        html += `
            <tr style="${o.orderStatus === '已取消' ? 'opacity: 0.6;' : ''}">
                <td style="padding:16px 20px;"><input type="checkbox" class="order-item-checkbox" value="${o.id}" ${isChecked} onchange="onOrderSelectChange('${o.id}', this.checked)"></td>
                <td style="font-family: Outfit; font-weight:700;"><a onclick="viewOrderDetail('${o.id}')" style="color:var(--primary-orange); cursor:pointer;">${o.id}</a></td>
                <td><span class="badge badge-id">${o.customerId}</span></td>
                <td style="font-weight:700;">${o.customerNickname}</td>
                <td>
                    <div style="font-weight:500;">${o.phone}</div>
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
                        <span class="badge badge-id">${o.customerId}</span>
                        <strong>${o.customerNickname}</strong>
                    </span>
                    <span class="badge badge-status-${getStatusClass(o.orderStatus)}">${o.orderStatus}</span>
                </div>
                <div class="mobile-card-divider"></div>
                <div class="mobile-card-items">
                    ${o.items.map(it => `<div>${it.productName} (${it.specs}) x ${it.quantity}</div>`).join('')}
                </div>
                <div class="mobile-card-row" style="font-size:13px;">
                    <span>取貨：<span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span></span>
                    <span>付款：<span class="badge ${o.paymentStatus === '已付款' ? 'badge-paid' : 'badge-unpaid'}">${o.paymentStatus}</span></span>
                </div>
                ${o.pickupType === '外送' ? `<div style="font-size:12px; color:var(--text-muted);"><i class="fa-solid fa-map-marker-alt"></i> ${o.address}</div>` : ''}
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
function batchUpdatePayment(status) {
    if (selectedOrderIds.length === 0) {
        alert("請先勾選欲修改的訂單！");
        return;
    }
    if (confirm(`確定要將選取的 ${selectedOrderIds.length} 筆訂單付款狀態修改為「${status}」嗎？`)) {
        state.orders.forEach(o => {
            if (selectedOrderIds.includes(o.id)) {
                o.paymentStatus = status;
            }
        });
        saveStateToStorage();
        renderOrdersList();
        alert("批次修改成功！");
    }
}

// 批次狀態更新
function batchUpdateOrderStatus(status) {
    if (!status) return;
    if (selectedOrderIds.length === 0) {
        alert("請先勾選欲修改的訂單！");
        return;
    }
    if (confirm(`確定要將選取的 ${selectedOrderIds.length} 筆訂單之訂單狀態修改為「${status}」嗎？`)) {
        state.orders.forEach(o => {
            if (selectedOrderIds.includes(o.id)) {
                o.orderStatus = status;
                // 若改為已包貨，自動將勾選狀態拉滿
                if (status === '已包貨') {
                    o.checkedProductIds = o.items.map(it => it.productId);
                }
            }
        });
        saveStateToStorage();
        renderOrdersList();
        document.getElementById('batch-order-status-select').value = ""; // 重設下拉選項
        alert("批次狀態修改成功！");
    }
}

// 單筆取消訂單 (不刪除資料)
function cancelOrder(id) {
    if (confirm(`確定要取消訂單 ${id} 嗎？此動作將只會更改狀態，不會永久刪除該訂單資料。`)) {
        const o = state.orders.find(x => x.id === id);
        if (o) {
            o.orderStatus = "已取消";
            saveStateToStorage();
            if (orderViewMode === 'list') {
                renderOrdersList();
            } else if (orderViewMode === 'by-customer') {
                renderCustomerSummaryView();
            }
            if (currentViewId === 'dashboard') renderDashboard();
            alert("訂單已標記為已取消！");
        }
    }
}

// 檢視單筆訂單明細內容
function viewOrderDetail(id) {
    const o = state.orders.find(x => x.id === id);
    if (!o) return;

    let itemsHtml = "";
    o.items.forEach(it => {
        itemsHtml += `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-light);">
                <span>${it.productName} <span style="color:var(--text-muted); font-size:12px;">(${it.specs || '無'})</span> x ${it.quantity} ${state.products.find(p=>p.id===it.productId)?.unit || '個'}</span>
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
            <p><strong>客戶編號：</strong><span class="badge badge-id">${o.customerId}</span></p>
            <p><strong>客戶暱稱：</strong>${o.customerNickname}</p>
            <p><strong>連絡電話：</strong>${o.phone}</p>
            <p><strong>取貨方式：</strong><span class="badge ${o.pickupType === '外送' ? 'badge-delivery' : 'badge-pickup'}">${o.pickupType}</span></p>
            ${o.pickupType === '外送' ? `<p><strong>外送地址：</strong>${o.address || '無'}</p>` : ''}
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
            <p><strong>備註說明：</strong>${o.notes || '無'}</p>
        </div>
    `;

    document.getElementById('order-view-content').innerHTML = content;
    openModal('order-view-modal');
}

// --- 購物車明細編輯功能 (Modal 內) ---
let cartItems = []; // 編輯中訂單的商品清單 [{productId, productName, specs, quantity, price, unit}]

function openOrderModal(orderId = '') {
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
        gbHtml += `<option value="${g.id}" ${g.id === state.activeGroupBuyId ? 'selected' : ''}>${g.name}</option>`;
    });
    document.getElementById('ord-group-buy').innerHTML = gbHtml || `<option value="">請先建立活動</option>`;

    // 載入客戶下拉清單 (依客戶編號自然排序)
    const sortedCusts = [...state.customers].sort((a, b) => a.id.localeCompare(b.id, undefined, {numeric: true}));
    let custHtml = `<option value="">-- 請選擇客戶 --</option>`;
    sortedCusts.forEach(c => {
        custHtml += `<option value="${c.id}">[${c.id}] ${c.nickname}</option>`;
    });
    document.getElementById('ord-customer-select').innerHTML = custHtml;

    if (orderId) {
        title.textContent = "編輯訂單資料";
        const o = state.orders.find(x => x.id === orderId);
        if (o) {
            document.getElementById('ord-group-buy').value = o.groupBuyId;
            document.getElementById('ord-customer-select').value = o.customerId;
            document.getElementById('ord-cust-nickname').value = o.customerNickname;
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

    renderCartTable();
    modal.classList.add('show');
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
        nicknameInput.value = c.nickname;
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
    const activeProds = state.products.filter(p => p.enabled);
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
    
    const activeProds = state.products.filter(p => p.enabled);
    let html = "";
    let total = 0;

    cartItems.forEach((item, index) => {
        const subtotal = item.price * item.quantity;
        total += subtotal;

        // 產生商品選擇下拉清單
        let optHtml = "";
        activeProds.forEach(p => {
            const isSelected = p.id === item.productId ? "selected" : "";
            optHtml += `<option value="${p.id}" ${isSelected}>[${p.id}] ${p.name}</option>`;
        });

        html += `
            <div class="cart-item-row">
                <select class="form-control" onchange="onCartItemProductChange(${index}, this.value)">
                    ${optHtml}
                </select>
                <span style="font-size:13px; color:var(--text-muted); text-align:center;">${item.specs || '-'}</span>
                <input type="number" class="form-control" style="text-align:center;" value="${item.quantity}" min="1" oninput="onCartItemQtyChange(${index}, this.value)">
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
    cartItems[index].quantity = qty;
    
    // 即時重算總額與小計，不整頁重新渲染，提升手機端輸入體驗
    document.getElementById('cart-total-amount').textContent = cartItems.reduce((s, it) => s + (it.price * it.quantity), 0);
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
function saveOrder() {
    const orderId = document.getElementById('order-id').value;
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

    const totalAmount = finalItems.reduce((sum, it) => sum + (it.price * it.quantity), 0);

    if (orderId) {
        // 編輯訂單
        const o = state.orders.find(x => x.id === orderId);
        if (o) {
            o.groupBuyId = groupBuyId;
            o.customerId = customerId;
            o.customerNickname = nickname;
            o.phone = phone;
            o.pickupType = pickupType;
            o.address = address;
            o.paymentStatus = paymentStatus;
            o.orderStatus = orderStatus;
            o.notes = notes;
            o.items = finalItems;
            o.totalAmount = totalAmount;
            
            // 若標記為已包貨，自動將 checklist 的 checked 狀態設為全選
            if (orderStatus === '已包貨') {
                o.checkedProductIds = finalItems.map(it => it.productId);
            }
        }
    } else {
        // 新增訂單
        // 自動生成編號
        let maxNum = 0;
        state.orders.forEach(o => {
            const match = o.id.match(/^ORD(\d+)$/i);
            if (match) {
                const num = parseInt(match[1], 10);
                if (num > maxNum) maxNum = num;
            }
        });
        const newOrderId = 'ORD' + String(maxNum + 1).padStart(5, '0');
        const nowStr = new Date().toLocaleString('zh-Hant-TW', { hour12: false }).replace(/\//g, '-');

        const newOrder = {
            id: newOrderId,
            groupBuyId,
            customerId,
            customerNickname: nickname,
            phone,
            address,
            pickupType,
            items: finalItems,
            totalAmount,
            paymentStatus,
            orderStatus,
            notes,
            createdDate: nowStr,
            checkedProductIds: orderStatus === '已包貨' ? finalItems.map(it => it.productId) : []
        };
        state.orders.push(newOrder);
    }

    saveStateToStorage();
    closeOrderModal();
    
    // 渲染對應子頁面
    if (orderViewMode === 'list') {
        renderOrdersList();
    } else if (orderViewMode === 'by-customer') {
        renderCustomerSummaryView();
    }
    
    if (currentViewId === 'dashboard') renderDashboard();
    alert("訂單資料儲存成功！");
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
            o.customerNickname.toLowerCase().includes(searchVal) ||
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
        if (sortVal === "name-asc") return a.customerNickname.localeCompare(b.customerNickname, "zh-Hant-TW");
        
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
                        ${it.productName} <span style="color:var(--text-muted); font-size:12px;">(${it.specs || '無'})</span> 
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
                        <span class="badge badge-id">${o.customerId}</span>
                        <span class="customer-name">${o.customerNickname}</span>
                        <span class="customer-contact"><i class="fa-solid fa-phone"></i> ${o.phone}</span>
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
                            <p><strong>外送地址：</strong>${o.pickupType === '外送' ? (o.address || '無') : '自取'}</p>
                            <p><strong>備註說明：</strong>${o.notes || '無'}</p>
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
    let html = "";

    // 篩選當前活動的訂單 (不含已取消)
    const activeOrders = state.orders.filter(o => o.groupBuyId === state.activeGroupBuyId && o.orderStatus !== "已取消");

    // 以商品為單位，加總訂購數量與人次
    const stats = {}; // productId -> {product, totalQty, buyers: Set(customerId)}

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

    // 轉化為數組並排序 (商品編號)
    const list = Object.values(stats).sort((a, b) => a.id.localeCompare(b.id, undefined, {numeric: true}));

    list.forEach(s => {
        html += `
            <tr>
                <td style="font-family: Outfit; font-weight:700;"><span class="badge badge-id">${s.id}</span></td>
                <td style="font-weight:700;">${s.name}</td>
                <td>${s.specs || '-'}</td>
                <td style="font-size:18px; font-weight:900; color:var(--primary-orange);">${s.totalQty}</td>
                <td style="font-weight:700;">${s.unit}</td>
                <td style="font-weight:700;">${s.buyers.size} 人</td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="viewProductBuyers('${s.id}')"><i class="fa-solid fa-list-check"></i> 查看名單</button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html || `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">本團尚無訂單商品統計</td></tr>`;
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
                    <td style="font-family: Outfit; font-weight:700;">${o.customerId}</td>
                    <td style="font-weight:700;">${o.customerNickname}</td>
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
let excelSubtab = 'import';
function toggleExcelSubtab(tab) {
    excelSubtab = tab;
    document.getElementById('tab-excel-import').className = tab === 'import' ? 'import-step active' : 'import-step';
    document.getElementById('tab-excel-export').className = tab === 'export' ? 'import-step active' : 'import-step';
    
    document.getElementById('excel-import-subview').style.display = tab === 'import' ? 'block' : 'none';
    document.getElementById('excel-export-subview').style.display = tab === 'export' ? 'block' : 'none';
    
    if (tab === 'import') {
        resetImportWizard();
    } else {
        // 匯出重設
        document.getElementById('export-filter-pickup').value = "all";
        document.getElementById('export-filter-payment').value = "all";
        document.getElementById('export-filter-status').value = "all";
        renderCurrentGroupBuySelect();
    }
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

    if (list.length === 0) {
        alert("目前選定的篩選條件下無任何訂單資料可匯出！");
        return;
    }

    // 1. 建立「客戶訂購總表」
    const dataSheet1 = list.map(o => {
        const prodSummary = o.items.map(it => `${it.productName}(${it.specs})x${it.quantity}`).join('、');
        const totalItemsCount = o.items.reduce((s, it) => s + it.quantity, 0);
        return {
            "客戶編號": o.customerId,
            "客戶暱稱": o.customerNickname,
            "連絡電話": o.phone,
            "配送地址": o.pickupType === "外送" ? o.address : "自取",
            "取貨方式": o.pickupType,
            "商品種類": o.items.length,
            "商品總件數": totalItemsCount,
            "訂單總額": o.totalAmount,
            "付款狀態": o.paymentStatus,
            "訂單狀態": o.orderStatus
        };
    });

    // 2. 建立「客戶商品明細」
    const dataSheet2 = [];
    list.forEach(o => {
        o.items.forEach(it => {
            dataSheet2.push({
                "客戶編號": o.customerId,
                "客戶暱稱": o.customerNickname,
                "商品編號": it.productId,
                "商品名稱": it.productName,
                "規格": it.specs || "",
                "數量": it.quantity,
                "單價": it.price,
                "小計": it.price * it.quantity
            });
        });
    });

    // 3. 建立「商品數量統計」
    const stats = {};
    list.forEach(o => {
        o.items.forEach(it => {
            if (!stats[it.productId]) {
                stats[it.productId] = {
                    "商品編號": it.productId,
                    "商品名稱": it.productName,
                    "規格": it.specs || "",
                    "總訂購數量": 0,
                    "單位": state.products.find(p=>p.id===it.productId)?.unit || '個',
                    "購買客戶數": new Set()
                };
            }
            stats[it.productId]["總訂購數量"] += it.quantity;
            stats[it.productId]["購買客戶數"].add(o.customerId);
        });
    });
    const dataSheet3 = Object.values(stats).map(s => ({
        ...s,
        "購買客戶數": s["購買客戶數"].size
    })).sort((a, b) => a["商品編號"].localeCompare(b["商品編號"], undefined, {numeric: true}));

    // 4. 建立「外送及自取名單」
    const dataSheet4 = list.map(o => ({
        "客戶編號": o.customerId,
        "客戶暱稱": o.customerNickname,
        "連絡電話": o.phone,
        "配送地址": o.pickupType === "外送" ? o.address : "",
        "取貨方式": o.pickupType,
        "訂單總額": o.totalAmount,
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


// --- Excel 匯入模組 (CSV/XLSX 解析與多行合併) ---
let importedData = null; // 暫存已解析尚未正式匯入的資料
let importErrors = [];
let importWarnings = [];
let importStats = { total: 0, newCount: 0, updateCount: 0, dupCount: 0, errCount: 0 };
let currentImportType = '';

function resetImportWizard() {
    document.getElementById('excel-import-type').value = "";
    document.getElementById('template-download-container').innerHTML = "";
    document.getElementById('excel-file-input').value = "";
    
    document.getElementById('import-step-2').style.display = 'none';
    document.getElementById('import-step-3').style.display = 'none';
    document.getElementById('selected-file-info').style.display = 'none';
    document.getElementById('import-errors-wrapper').style.display = 'none';
    document.getElementById('import-warnings-wrapper').style.display = 'none';
    
    importedData = null;
    importErrors = [];
    importWarnings = [];
    importStats = { total: 0, newCount: 0, updateCount: 0, dupCount: 0, errCount: 0 };
}

// 選擇匯入類型，並生成模板下載按鈕
function onImportTypeSelect() {
    const type = document.getElementById('excel-import-type').value;
    currentImportType = type;
    const dlContainer = document.getElementById('template-download-container');
    
    if (!type) {
        resetImportWizard();
        return;
    }

    let btnHtml = "";
    if (type === 'customers') {
        btnHtml = `<button class="btn btn-secondary btn-sm" onclick="downloadTemplate('customers')"><i class="fa-solid fa-download"></i> 下載「客戶」Excel範本</button>`;
    } else if (type === 'products') {
        btnHtml = `<button class="btn btn-secondary btn-sm" onclick="downloadTemplate('products')"><i class="fa-solid fa-download"></i> 下載「商品」Excel範本</button>`;
    } else if (type === 'orders') {
        btnHtml = `<button class="btn btn-secondary btn-sm" onclick="downloadTemplate('orders')"><i class="fa-solid fa-download"></i> 下載「訂單」Excel範本</button>`;
    }

    dlContainer.innerHTML = btnHtml;
    document.getElementById('import-step-2').style.display = 'block';
    document.getElementById('import-step-3').style.display = 'none';
}

// 生成範本 CSV 供下載
function downloadTemplate(type) {
    let headers = [];
    let filename = "";
    let data = [];

    if (type === 'customers') {
        headers = ["客戶編號", "客戶暱稱", "連絡電話", "配送地址", "客戶備註"];
        data = [
            ["A001", "陳小明", "0912-345-678", "台北市信義區信義路五段7號", "常買紅茶"],
            ["A002", "林美玲", "0928 765 432", "新北市板橋區縣民大道二段3號", "外送大樓需管理室收"]
        ];
        filename = "阿賢Easy購_客戶資料匯入範本.csv";
    } else if (type === 'products') {
        headers = ["商品編號", "商品名稱", "規格口味", "售價", "單位", "是否啟用"];
        data = [
            ["P001", "手工古早味蛋捲", "原味 / 12入", 180, "盒", "是"],
            ["P002", "手作韭菜水餃", "30顆裝", 150, "包", "是"]
        ];
        filename = "阿賢Easy購_商品資料匯入範本.csv";
    } else if (type === 'orders') {
        headers = ["客戶編號", "客戶暱稱", "連絡電話", "外送地址", "取貨方式", "付款狀態", "商品編號", "商品名稱", "數量", "單價", "訂單備註"];
        data = [
            ["A001", "陳小明", "0912-345-678", "", "自取", "已付款", "P001", "手工古早味蛋捲", 2, 180, "週六拿"],
            ["A001", "陳小明", "0912-345-678", "", "自取", "已付款", "P005", "阿賢特調冰紅茶", 3, 60, "同上合併"],
            ["A002", "林美玲", "0928 765 432", "新北市板橋區縣民大道二段3號", "外送", "未付款", "P003", "手作韭菜水餃", 2, 150, ""]
        ];
        filename = "阿賢Easy購_訂單資料匯入範本.csv";
    }

    // 產出 CSV 字串 (採用 BOM UTF-8 以防 Excel 開啟時亂碼)
    let csvContent = "\uFEFF";
    csvContent += headers.join(",") + "\n";
    data.forEach(row => {
        // 若欄位中包含英文逗號，需使用引號包起
        const formattedRow = row.map(val => {
            const valStr = String(val);
            if (valStr.includes(',')) return `"${valStr}"`;
            return valStr;
        });
        csvContent += formattedRow.join(",") + "\n";
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

function triggerFileInput() {
    document.getElementById('excel-file-input').click();
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    document.getElementById('selected-file-name').textContent = file.name;
    document.getElementById('selected-file-info').style.display = 'block';

    const reader = new FileReader();
    reader.onload = function(e) {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        // 轉為 JSON
        const rawJson = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        parseAndValidateImportData(rawJson);
    };
    reader.readAsArrayBuffer(file);
}

// 解析並檢驗 Excel 資料
function parseAndValidateImportData(matrix) {
    if (matrix.length < 2) {
        alert("匯入的檔案內容為空或無標題列！");
        return;
    }

    const headers = matrix[0].map(h => String(h).trim());
    const rows = matrix.slice(1).filter(r => r.length > 0 && r.some(cell => cell !== null && cell !== "")); // 排除空列

    importErrors = [];
    importWarnings = [];
    importStats = { total: rows.length, newCount: 0, updateCount: 0, dupCount: 0, errCount: 0 };
    
    let previewHtmlHead = "<tr><th>Excel列</th>";
    headers.forEach(h => {
        previewHtmlHead += `<th>${h}</th>`;
    });
    previewHtmlHead += "</tr>";
    document.getElementById('import-preview-thead').innerHTML = previewHtmlHead;

    let previewHtmlBody = "";
    importedData = [];

    // --- 1. 客戶資料匯入處理 ---
    if (currentImportType === 'customers') {
        rows.forEach((row, i) => {
            const rowNum = i + 2; // Excel 2行開始
            const id = getCellValue(row, headers, "客戶編號");
            const nickname = getCellValue(row, headers, "客戶暱稱");
            const phone = getCellValue(row, headers, "連絡電話");
            const address = getCellValue(row, headers, "配送地址") || "";
            const notes = getCellValue(row, headers, "客戶備註") || "";

            let rowHasError = false;
            
            // 驗證
            if (!id) {
                importErrors.push({ row: rowNum, field: "客戶編號", reason: "必填欄位空白" });
                rowHasError = true;
            }
            if (!nickname) {
                importErrors.push({ row: rowNum, field: "客戶暱稱", reason: "必填欄位空白" });
                rowHasError = true;
            }
            if (!phone) {
                importErrors.push({ row: rowNum, field: "連絡電話", reason: "必填欄位空白" });
                rowHasError = true;
            } else {
                // 電話格式檢查 (防呆至少要有數字)
                const numbers = phone.replace(/\D/g, "");
                if (numbers.length < 7) {
                    importErrors.push({ row: rowNum, field: "連絡電話", reason: "格式錯誤，長度太短" });
                    rowHasError = true;
                }
            }

            // 判斷新增或更新
            let isUpdate = false;
            if (!rowHasError) {
                const exist = state.customers.find(c => c.id === id);
                if (exist) {
                    isUpdate = true;
                    importStats.updateCount++;
                } else {
                    importStats.newCount++;
                }

                // 疑似重複客戶警示
                const cleanPhone = formatPhoneForCompare(phone);
                state.customers.forEach(c => {
                    if (c.id === id) return; // 略過主鍵更新的情況

                    let warningMsg = "";
                    if (formatPhoneForCompare(c.phone) === cleanPhone) {
                        warningMsg = `列 ${rowNum} 連絡電話與系統內 [${c.id}] ${c.nickname} 相同`;
                    } else if (nickname && address && c.nickname === nickname && c.address === address) {
                        warningMsg = `列 ${rowNum} 暱稱與外送地址皆與系統內 [${c.id}] 相同`;
                    }

                    if (warningMsg) {
                        importWarnings.push(warningMsg);
                        importStats.dupCount++;
                    }
                });

                importedData.push({ id, nickname, phone, address, notes });
            } else {
                importStats.errCount++;
            }

            // 渲染預覽列
            previewHtmlBody += `<tr class="${rowHasError ? 'style="background-color:#FFF2F2; color:#D63D3B;"' : ''}">`;
            previewHtmlBody += `<td>${rowNum}</td>`;
            headers.forEach(h => {
                const idx = headers.indexOf(h);
                previewHtmlBody += `<td>${row[idx] !== undefined ? row[idx] : ''}</td>`;
            });
            previewHtmlBody += "</tr>";
        });
    } 
    // --- 2. 商品資料匯入處理 ---
    else if (currentImportType === 'products') {
        rows.forEach((row, i) => {
            const rowNum = i + 2;
            const id = getCellValue(row, headers, "商品編號");
            const name = getCellValue(row, headers, "商品名稱");
            const specs = getCellValue(row, headers, "規格口味") || "";
            const priceVal = getCellValue(row, headers, "售價");
            const unit = getCellValue(row, headers, "單位");
            const enabledStr = getCellValue(row, headers, "是否啟用") || "是";

            let rowHasError = false;

            if (!id) {
                importErrors.push({ row: rowNum, field: "商品編號", reason: "必填欄位空白" });
                rowHasError = true;
            }
            if (!name) {
                importErrors.push({ row: rowNum, field: "商品名稱", reason: "必填欄位空白" });
                rowHasError = true;
            }
            if (!priceVal) {
                importErrors.push({ row: rowNum, field: "售價", reason: "必填欄位空白" });
                rowHasError = true;
            } else {
                const price = parseFloat(priceVal);
                if (isNaN(price)) {
                    importErrors.push({ row: rowNum, field: "售價", reason: "售價不是數字" });
                    rowHasError = true;
                } else if (price < 0) {
                    importErrors.push({ row: rowNum, field: "售價", reason: "售價不能小於 0" });
                    rowHasError = true;
                }
            }
            if (!unit) {
                importErrors.push({ row: rowNum, field: "單位", reason: "必填欄位空白" });
                rowHasError = true;
            }

            const enabled = ["是", "啟用", "true", "y"].includes(String(enabledStr).trim().toLowerCase());

            if (!rowHasError) {
                const exist = state.products.find(p => p.id === id);
                if (exist) {
                    importStats.updateCount++;
                } else {
                    importStats.newCount++;
                }
                importedData.push({ id, name, specs, price: parseFloat(priceVal), unit, enabled, photo: "" });
            } else {
                importStats.errCount++;
            }

            previewHtmlBody += `<tr><td>${rowNum}</td>`;
            headers.forEach(h => {
                const idx = headers.indexOf(h);
                previewHtmlBody += `<td>${row[idx] !== undefined ? row[idx] : ''}</td>`;
            });
            previewHtmlBody += "</tr>";
        });
    }
    // --- 3. 訂單資料匯入處理 (重點：多行合併同客戶) ---
    else if (currentImportType === 'orders') {
        // 先依照「客戶編號」將明細分組
        const groups = {}; // customerId -> [rows]
        
        rows.forEach((row, i) => {
            const rowNum = i + 2;
            const custId = getCellValue(row, headers, "客戶編號");
            const nickname = getCellValue(row, headers, "客戶暱稱");
            const phone = getCellValue(row, headers, "連絡電話");
            const address = getCellValue(row, headers, "外送地址") || "";
            const pickupType = getCellValue(row, headers, "取貨方式");
            const paymentStatus = getCellValue(row, headers, "付款狀態");
            const prodId = getCellValue(row, headers, "商品編號");
            const prodName = getCellValue(row, headers, "商品名稱");
            const qtyVal = getCellValue(row, headers, "數量");
            const priceVal = getCellValue(row, headers, "單價");
            const orderNotes = getCellValue(row, headers, "訂單備註") || "";

            let rowHasError = false;

            // 格式與欄位驗證
            if (!custId) {
                importErrors.push({ row: rowNum, field: "客戶編號", reason: "必填欄位空白" });
                rowHasError = true;
            }
            if (!nickname) {
                importErrors.push({ row: rowNum, field: "客戶暱稱", reason: "必填欄位空白" });
                rowHasError = true;
            }
            if (!phone) {
                importErrors.push({ row: rowNum, field: "連絡電話", reason: "必填欄位空白" });
                rowHasError = true;
            }
            if (!pickupType) {
                importErrors.push({ row: rowNum, field: "取貨方式", reason: "必填欄位空白" });
                rowHasError = true;
            } else if (!["外送", "自取"].includes(pickupType)) {
                importErrors.push({ row: rowNum, field: "取貨方式", reason: "取貨方式不是外送或自取" });
                rowHasError = true;
            }
            if (pickupType === "外送" && !address) {
                importErrors.push({ row: rowNum, field: "外送地址", reason: "外送時，地址為必填項目" });
                rowHasError = true;
            }
            if (!paymentStatus) {
                importErrors.push({ row: rowNum, field: "付款狀態", reason: "必填欄位空白" });
                rowHasError = true;
            } else if (!["已付款", "未付款"].includes(paymentStatus)) {
                importErrors.push({ row: rowNum, field: "付款狀態", reason: "付款狀態格式錯誤 (限填已付款或未付款)" });
                rowHasError = true;
            }
            if (!prodId) {
                importErrors.push({ row: rowNum, field: "商品編號", reason: "商品編號空白" });
                rowHasError = true;
            } else {
                const prod = state.products.find(p => p.id === prodId);
                if (!prod) {
                    importErrors.push({ row: rowNum, field: "商品編號", reason: `商品編號 [${prodId}] 不存在` });
                    rowHasError = true;
                }
            }
            if (!qtyVal) {
                importErrors.push({ row: rowNum, field: "數量", reason: "數量空白" });
                rowHasError = true;
            } else {
                const qty = parseInt(qtyVal, 10);
                if (isNaN(qty)) {
                    importErrors.push({ row: rowNum, field: "數量", reason: "數量不是數字" });
                    rowHasError = true;
                } else if (qty <= 0) {
                    importErrors.push({ row: rowNum, field: "數量", reason: "數量小於或等於零" });
                    rowHasError = true;
                }
            }

            // 售價數值檢查 (若為空則套用資料庫預設售價)
            let price = 0;
            if (priceVal) {
                price = parseFloat(priceVal);
                if (isNaN(price)) {
                    importErrors.push({ row: rowNum, field: "單價", reason: "單價不是數字" });
                    rowHasError = true;
                }
            } else if (prodId) {
                const prod = state.products.find(p => p.id === prodId);
                price = prod ? prod.price : 0;
            }

            if (!rowHasError) {
                if (!groups[custId]) {
                    groups[custId] = {
                        customerId: custId,
                        customerNickname: nickname,
                        phone: phone,
                        address: address,
                        pickupType: pickupType,
                        paymentStatus: paymentStatus,
                        orderStatus: "新訂單",
                        notes: orderNotes,
                        items: []
                    };
                }
                
                // 檢查此商品是否已被加入本訂單
                const existItem = groups[custId].items.find(it => it.productId === prodId);
                if (existItem) {
                    existItem.quantity += parseInt(qtyVal, 10); // 重複出現則數量累加
                } else {
                    const prod = state.products.find(p => p.id === prodId);
                    groups[custId].items.push({
                        productId: prodId,
                        productName: prodName || (prod ? prod.name : ""),
                        specs: prod ? prod.specs : "",
                        quantity: parseInt(qtyVal, 10),
                        price: price
                    });
                }
            } else {
                importStats.errCount++;
            }

            previewHtmlBody += `<tr><td>${rowNum}</td>`;
            headers.forEach(h => {
                const idx = headers.indexOf(h);
                previewHtmlBody += `<td>${row[idx] !== undefined ? row[idx] : ''}</td>`;
            });
            previewHtmlBody += "</tr>";
        });

        // 轉換為訂單陣列，並推算新增與更新數
        if (importErrors.length === 0) {
            Object.values(groups).forEach(g => {
                const totalAmount = g.items.reduce((s, it) => s + (it.price * it.quantity), 0);
                
                // 檢查目前團購活動中，該客戶是否已有訂單
                const existOrder = state.orders.find(o => o.groupBuyId === state.activeGroupBuyId && o.customerId === g.customerId);
                
                let orderId = "";
                if (existOrder) {
                    orderId = existOrder.id;
                    importStats.updateCount++;
                } else {
                    importStats.newCount++;
                }

                importedData.push({
                    id: orderId, // 留空代表新建
                    groupBuyId: state.activeGroupBuyId,
                    customerId: g.customerId,
                    customerNickname: g.customerNickname,
                    phone: g.phone,
                    address: g.address,
                    pickupType: g.pickupType,
                    items: g.items,
                    totalAmount: totalAmount,
                    paymentStatus: g.paymentStatus,
                    orderStatus: g.orderStatus,
                    notes: g.notes,
                    createdDate: new Date().toLocaleString('zh-Hant-TW', { hour12: false }).replace(/\//g, '-'),
                    checkedProductIds: []
                });
            });
        }
    }

    // 渲染 UI 統計面板
    document.getElementById('import-stat-total').textContent = importStats.total;
    document.getElementById('import-stat-new').textContent = importStats.newCount;
    document.getElementById('import-stat-update').textContent = importStats.updateCount;
    document.getElementById('import-stat-dup').textContent = importStats.dupCount;
    document.getElementById('import-stat-err').textContent = importStats.errCount;

    // 顯示錯誤警示
    const errWrapper = document.getElementById('import-errors-wrapper');
    const errContainer = document.getElementById('import-errors-container');
    if (importErrors.length > 0) {
        errWrapper.style.display = 'block';
        let errHtml = "";
        importErrors.forEach(err => {
            errHtml += `<div class="error-item"><span class="row-num">第 ${err.row} 列</span> <strong>[${err.field}]</strong> ${err.reason}</div>`;
        });
        errContainer.innerHTML = errHtml;
        document.getElementById('btn-execute-import').disabled = true; // 包含錯誤，鎖定匯入按鈕
    } else {
        errWrapper.style.display = 'none';
        document.getElementById('btn-execute-import').disabled = false; // 無錯誤，解鎖
    }

    // 顯示重複警示
    const warnWrapper = document.getElementById('import-warnings-wrapper');
    const warnContainer = document.getElementById('import-warnings-container');
    if (importWarnings.length > 0) {
        warnWrapper.style.display = 'block';
        let warnHtml = "";
        importWarnings.forEach(w => {
            warnHtml += `<li>${w}</li>`;
        });
        warnContainer.innerHTML = warnHtml;
    } else {
        warnWrapper.style.display = 'none';
    }

    document.getElementById('import-preview-tbody').innerHTML = previewHtmlBody;
    document.getElementById('import-step-3').style.display = 'block';
}

function getCellValue(row, headers, targetHeader) {
    const idx = headers.indexOf(targetHeader);
    if (idx === -1 || row[idx] === undefined) return null;
    return String(row[idx]).trim();
}

// 執行正式匯入寫入
function executeImport() {
    if (!importedData || importedData.length === 0) return;

    if (currentImportType === 'customers') {
        importedData.forEach(c => {
            const idx = state.customers.findIndex(x => x.id === c.id);
            if (idx > -1) {
                // 更新
                state.customers[idx] = c;
            } else {
                // 新增
                state.customers.push(c);
            }
        });
        saveStateToStorage();
        alert(`已成功匯入 ${importedData.length} 筆客戶資料！`);
    } else if (currentImportType === 'products') {
        importedData.forEach(p => {
            const idx = state.products.findIndex(x => x.id === p.id);
            if (idx > -1) {
                state.products[idx] = p;
            } else {
                state.products.push(p);
            }
        });
        saveStateToStorage();
        alert(`已成功匯入 ${importedData.length} 筆商品資料！`);
    } else if (currentImportType === 'orders') {
        // 新增或覆蓋當前團購的訂單
        let newOrdersAdded = 0;
        let ordersUpdated = 0;

        importedData.forEach(newO => {
            // 建立或自動更新客戶庫資訊 (若不存在則順便自動建立客戶，防呆且方便！)
            const cExist = state.customers.find(c => c.id === newO.customerId);
            if (!cExist) {
                state.customers.push({
                    id: newO.customerId,
                    nickname: newO.customerNickname,
                    phone: newO.phone,
                    address: newO.address,
                    notes: "匯入訂單時自動建立的客戶"
                });
            }

            const idx = state.orders.findIndex(o => o.groupBuyId === newO.groupBuyId && o.customerId === newO.customerId);
            if (idx > -1) {
                // 原本已有訂單，複寫商品明細
                state.orders[idx].items = newO.items;
                state.orders[idx].totalAmount = newO.totalAmount;
                state.orders[idx].paymentStatus = newO.paymentStatus;
                state.orders[idx].pickupType = newO.pickupType;
                state.orders[idx].address = newO.address;
                state.orders[idx].phone = newO.phone;
                state.orders[idx].customerNickname = newO.customerNickname;
                ordersUpdated++;
            } else {
                // 新增
                // 計算 ID ORD00001
                let maxNum = 0;
                state.orders.forEach(o => {
                    const match = o.id.match(/^ORD(\d+)$/i);
                    if (match) {
                        const num = parseInt(match[1], 10);
                        if (num > maxNum) maxNum = num;
                    }
                });
                newO.id = 'ORD' + String(maxNum + 1).padStart(5, '0');
                state.orders.push(newO);
                newOrdersAdded++;
            }
        });

        saveStateToStorage();
        alert(`訂單匯入成功！新增訂單：${newOrdersAdded} 筆，覆蓋更新：${ordersUpdated} 筆。`);
    }

    resetImportWizard();
    if (currentViewId === 'dashboard') renderDashboard();
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
function getLineApiBase() {
    return (localStorage.getItem('easygo_line_api_base') || '').replace(/\/$/, '');
}

function renderLineSettings() {
    const input = document.getElementById('line-api-base');
    if (input) input.value = getLineApiBase();
    const keyInput = document.getElementById('line-admin-api-key');
    if (keyInput) keyInput.value = localStorage.getItem('easygo_line_admin_api_key') || '';
}

function saveLineSettings() {
    const value = document.getElementById('line-api-base').value.trim().replace(/\/$/, '');
    const apiKey = document.getElementById('line-admin-api-key').value.trim();
    localStorage.setItem('easygo_line_api_base', value);
    localStorage.setItem('easygo_line_admin_api_key', apiKey);
    alert('LINE 後台連線設定已儲存。靜默模式維持強制啟用。');
}

function escapeLineText(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function renderLineInbox() {
    const tbody = document.getElementById('line-inbox-tbody');
    if (!tbody) return;
    if (!state.lineInbox.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">尚無 LINE 收件資料，或尚未設定 Worker API 網址。</td></tr>';
        return;
    }
    tbody.innerHTML = state.lineInbox.map(row => {
        let items = row.parsed_items || row.parsedItems || [];
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_error) { items = []; } }
        const status = row.status || '已接收';
        const canImport = status === '已解析' && Boolean(row.customer_id || row.customerId);
        return `<tr>
            <td><strong>${escapeLineText(row.display_name || row.displayName)}</strong><small>${escapeLineText(row.line_user_id || row.lineUserId)}</small></td>
            <td>${escapeLineText(row.customer_id || row.customerId)}<small>${escapeLineText(row.customer_nickname || row.customerNickname)}</small></td>
            <td>${escapeLineText(row.raw_message || row.rawMessage)}</td><td>${escapeLineText(row.normalized_message || row.normalizedMessage)}</td>
            <td>${items.map(item => `${escapeLineText(item.productCode)} × ${Number(item.quantity)}`).join('<br>')}</td>
            <td>${escapeLineText(row.pickup_type || row.pickupType)}</td><td>${escapeLineText(row.message_time || row.messageTime)}</td>
            <td><span class="line-status">${escapeLineText(status)}</span></td><td>${escapeLineText(row.error_reason || row.errorReason)}</td>
            <td><button class="btn btn-primary btn-sm" ${canImport ? '' : 'disabled'} onclick="importLineInbox('${encodeURIComponent(row.message_id || row.messageId)}')">轉正式訂單</button></td>
        </tr>`;
    }).join('');
}

async function loadLineInbox() {
    const base = getLineApiBase();
    if (!base) { state.lineInbox = []; renderLineInbox(); return; }
    try {
        const response = await fetch(`${base}/api/line-inbox`, { headers: { authorization: `Bearer ${localStorage.getItem('easygo_line_admin_api_key') || ''}` } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.lineInbox = await response.json();
        renderLineInbox();
    } catch (error) {
        state.lineInbox = [];
        renderLineInbox();
        alert(`無法讀取 LINE 訂單收件匣：${error.message}`);
    }
}

async function importLineInbox(encodedMessageId) {
    if (!confirm('確定將這筆 LINE 收件資料轉為正式訂單？')) return;
    const response = await fetch(`${getLineApiBase()}/api/line-inbox/${encodedMessageId}/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${localStorage.getItem('easygo_line_admin_api_key') || ''}` }
    });
    const result = await response.json();
    if (!response.ok) { alert(result.error || '轉單失敗'); return; }
    await loadLineInbox();
    alert(result.imported ? '已轉為正式訂單。' : '此訊息先前已完成轉單。');
}

// LINE 收件匣 v2：支援「P023 A+3」、更正與取消命令。
// 這些同名函式刻意放在舊版之後，讓既有 onclick 與頁面生命週期不必改動。
function renderLineInboxV2() {
    const tbody = document.getElementById('line-inbox-tbody');
    if (!tbody) return;
    if (!state.lineInbox.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">尚無 LINE 收件資料，請先設定 Worker API。</td></tr>';
        return;
    }
    tbody.innerHTML = state.lineInbox.map(row => {
        let items = row.parsed_items || row.parsedItems || [];
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_error) { items = []; } }
        const status = row.status || '待處理';
        const action = row.action || 'create';
        const actionLabels = { create: '新增', replace: '更正', cancel: '取消' };
        const canImport = status === '可匯入' && Boolean(row.customer_id || row.customerId);
        const itemText = items.length
            ? items.map(item => `${escapeLineText(item.productCode)} × ${Number(item.quantity)}`).join('<br>')
            : escapeLineText(row.target_product_prefix || '');
        return `<tr>
            <td><strong>${escapeLineText(row.display_name || row.displayName)}</strong><small>${escapeLineText(row.line_user_id || row.lineUserId)}</small></td>
            <td>${escapeLineText(row.customer_id || row.customerId)}<small>${escapeLineText(row.customer_nickname || row.customerNickname)}</small></td>
            <td><span class="line-action line-action-${escapeLineText(action)}">${actionLabels[action] || action}</span><br>${escapeLineText(row.raw_message || row.rawMessage)}</td>
            <td>${escapeLineText(row.normalized_message || row.normalizedMessage)}</td>
            <td>${itemText}</td>
            <td>${escapeLineText(row.pickup_type || row.pickupType)}</td><td>${escapeLineText(row.message_time || row.messageTime)}</td>
            <td><span class="line-status">${escapeLineText(status)}</span></td><td>${escapeLineText(row.error_reason || row.errorReason)}</td>
            <td><button class="btn btn-primary btn-sm" ${canImport ? '' : 'disabled'} onclick="importLineInboxV2('${encodeURIComponent(row.message_id || row.messageId)}')">${action === 'cancel' ? '確認取消' : action === 'replace' ? '確認更正' : '轉正式訂單'}</button></td>
        </tr>`;
    }).join('');
}

async function loadLineInboxV2() {
    const base = getLineApiBase();
    if (!base) { state.lineInbox = []; renderLineInboxV2(); return; }
    try {
        const response = await fetch(`${base}/api/line-inbox`, { headers: { authorization: `Bearer ${localStorage.getItem('easygo_line_admin_api_key') || ''}` } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.lineInbox = await response.json();
        renderLineInboxV2();
    } catch (error) {
        state.lineInbox = [];
        renderLineInboxV2();
        alert(`無法讀取 LINE 訂單收件匣：${error.message}`);
    }
}

async function importLineInboxV2(encodedMessageId) {
    if (!confirm('確定要處理這筆 LINE 收件資料嗎？')) return;
    const response = await fetch(`${getLineApiBase()}/api/line-inbox/${encodedMessageId}/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${localStorage.getItem('easygo_line_admin_api_key') || ''}` }
    });
    const result = await response.json();
    if (!response.ok) { alert(result.error || '處理失敗'); return; }
    await loadLineInboxV2();
    alert(result.imported ? '處理完成。' : '這筆資料先前已處理。');
}

// 保留原本頁面呼叫名稱。
renderLineInbox = renderLineInboxV2;
loadLineInbox = loadLineInboxV2;
importLineInbox = importLineInboxV2;
