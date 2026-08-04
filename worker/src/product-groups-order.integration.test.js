// 「一個商品、多個口味」情境下的訂單／庫存整合測試：
// 每個口味都是獨立的 products/group_buy_products 資料列，驗證：
//   - 口味之間庫存互不影響（訂購/取消/售完）。
//   - order_items 會寫入名稱快照，且快照建立後不會被之後的數量調整覆寫。
//   - 換口味（檨檬→蘆薈）在庫存不足時整筆訂單維持不變（原子交易，不留半套資料）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const worker = require("./index.js");
const ProductGroups = require("./product-groups.js");

class D1Statement {
    constructor(database, sql, args = []) {
        this.database = database;
        this.sql = sql;
        this.args = args;
    }
    bind(...args) { return new D1Statement(this.database, this.sql, args); }
    async run() {
        const result = this.database.prepare(this.sql).run(...this.args);
        return { meta: { changes: Number(result.changes || 0) } };
    }
    async first() { return this.database.prepare(this.sql).get(...this.args) || null; }
    async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
}

function createD1() {
    const database = new DatabaseSync(":memory:");
    database.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    return {
        database,
        prepare(sql) { return new D1Statement(database, sql); },
        async batch(statements) {
            database.exec("BEGIN IMMEDIATE");
            try {
                const results = [];
                for (const statement of statements) results.push(await statement.run());
                database.exec("COMMIT");
                return results;
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        }
    };
}

function request(method, pathname, body) {
    return new Request(`https://worker.test${pathname}`, {
        method,
        headers: {
            authorization: "Bearer test-admin",
            ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

async function call(db, method, pathname, body) {
    const response = await worker.fetch(request(method, pathname, body), { DB: db, ADMIN_API_KEY: "test-admin" }, {});
    let json = null;
    try { json = await response.json(); } catch (_error) { json = null; }
    return { status: response.status, json };
}

async function configure(db, productId, incoming, reserved = 0, threshold = 3) {
    const result = await call(db, "PUT", `/api/group-buys/GB1/stock/${productId}`, {
        stockEnabled: true, incomingQuantity: incoming, reservedQuantity: reserved, lowStockThreshold: threshold
    });
    assert.equal(result.status, 200);
    return result.json;
}

async function seedPrilGroup(db) {
    const created = await call(db, "POST", "/api/product-groups", {
        requestId: "seed-req-1",
        name: "德國 Pril 洗碗精",
        variants: [
            { variant_name: "檨檬", specs: "653ml x 3瓶", price: 210, pickup_price: 210, delivery_price: 225 },
            { variant_name: "蘆薈", specs: "750ml x 3瓶", price: 210, pickup_price: 210, delivery_price: 225 }
        ]
    });
    assert.equal(created.status, 201);
    const [lemon, aloe] = created.json.variantIds;
    db.database.exec(`
        INSERT INTO customers (id, nickname) VALUES ('C1', '甲'), ('C2', '乙'), ('C3', '丙');
        INSERT INTO group_buys (id, name, ends_at, status) VALUES ('GB1', '[TEST] Pril 團', '2099-12-31T15:59:59.000Z', 'open');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES ('GB1', '${lemon}'), ('GB1', '${aloe}');
    `);
    return { groupId: created.json.id, lemon, aloe };
}

function order(requestId, customerId, productId, quantity, unitPrice = 210) {
    return {
        requestId, groupBuyId: "GB1", customerId, pickupType: "自取", paymentStatus: "未付款", orderStatus: "新訂單",
        phone: "0912", address: "", notes: "",
        items: quantity === 0 ? [] : [{ productId, quantity, unitPrice }]
    };
}

test("下單檨檬只扣檨檬庫存，蘆薈庫存不受影響；order_items 寫入名稱快照", async () => {
    const db = createD1();
    const { lemon, aloe } = await seedPrilGroup(db);
    await configure(db, lemon, 10, 0, 2);
    await configure(db, aloe, 6, 0, 2);

    const response = await call(db, "PUT", "/api/admin/orders/O-LEMON", order("REQ-L1", "C1", lemon, 2));
    assert.equal(response.status, 200);

    const lemonStock = db.database.prepare("SELECT remaining_quantity, sold_quantity FROM group_buy_products WHERE product_id = ?").get(lemon);
    assert.equal(lemonStock.remaining_quantity, 8);
    assert.equal(lemonStock.sold_quantity, 2);
    const aloeStock = db.database.prepare("SELECT remaining_quantity, sold_quantity FROM group_buy_products WHERE product_id = ?").get(aloe);
    assert.equal(aloeStock.remaining_quantity, 6);
    assert.equal(aloeStock.sold_quantity, 0);

    const item = db.database.prepare("SELECT * FROM order_items WHERE order_id = 'O-LEMON'").get();
    assert.equal(item.product_name_snapshot, "德國 Pril 洗碗精 檨檬");
    assert.equal(item.variant_name_snapshot, "檨檬");
    assert.equal(item.specs_snapshot, "653ml x 3瓶");
});

test("訂購蘆薈只扣蘆薈庫存；單一口味售完時其他口味仍可購買", async () => {
    const db = createD1();
    const { lemon, aloe } = await seedPrilGroup(db);
    await configure(db, lemon, 10, 0, 2);
    await configure(db, aloe, 1, 0, 0);

    const aloeOrder = await call(db, "PUT", "/api/admin/orders/O-ALOE", order("REQ-A1", "C2", aloe, 1));
    assert.equal(aloeOrder.status, 200);
    const aloeStock = db.database.prepare("SELECT remaining_quantity, stock_status FROM group_buy_products WHERE product_id = ?").get(aloe);
    assert.equal(aloeStock.remaining_quantity, 0);
    assert.equal(aloeStock.stock_status, "sold_out");

    // 蘆薈已售完，再買會被擋下
    const oversell = await call(db, "PUT", "/api/admin/orders/O-ALOE-2", order("REQ-A2", "C3", aloe, 1));
    assert.equal(oversell.status, 409);
    assert.equal(oversell.json.error, "SOLD_OUT");

    // 檨檬完全不受影響，C3 仍可正常買檨檬
    const lemonOrder = await call(db, "PUT", "/api/admin/orders/O-LEMON-2", order("REQ-L2", "C3", lemon, 3));
    assert.equal(lemonOrder.status, 200);
    const lemonStock = db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id = ?").get(lemon);
    assert.equal(lemonStock.remaining_quantity, 7);

    // 主商品整體狀態：部分口味售完
    const lemonRow = { stockEnabled: true, stockStatus: "in_stock" };
    const aloeRow = { stockEnabled: true, stockStatus: "sold_out" };
    assert.equal(ProductGroups.summarizeGroupStock([lemonRow, aloeRow]), "partial_sold_out");
    assert.equal(ProductGroups.summarizeGroupStock([aloeRow, aloeRow]), "all_sold_out");
    assert.equal(ProductGroups.summarizeGroupStock([lemonRow, lemonRow]), "open");
});

test("修改數量只扣或回補差額，快照不會因為調整數量而被覆寫", async () => {
    const db = createD1();
    const { lemon } = await seedPrilGroup(db);
    await configure(db, lemon, 10, 0, 2);

    await call(db, "PUT", "/api/admin/orders/ORD-1", order("REQ-1", "C1", lemon, 1));
    let stock = db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id = ?").get(lemon);
    assert.equal(stock.remaining_quantity, 9);

    // 原訂 1 組改成 3 組：只再扣 2 組
    await call(db, "PUT", "/api/admin/orders/ORD-1", order("REQ-2", "C1", lemon, 3));
    stock = db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id = ?").get(lemon);
    assert.equal(stock.remaining_quantity, 7);

    // 把主商品名稱改掉之後，既有訂單明細的快照仍維持建立當時的名稱
    db.database.prepare("UPDATE products SET name = ? WHERE id = ?").run("德國 Pril 洗碗精 檨檬（改名後）", lemon);
    const item = db.database.prepare("SELECT product_name_snapshot FROM order_items WHERE order_id = 'ORD-1'").get();
    assert.equal(item.product_name_snapshot, "德國 Pril 洗碗精 檨檬");

    // 取消訂單只回補該口味（後台取消需明確標記 orderStatus 已取消，才會把所有明細歸零回補）
    const cancelled = await call(db, "PUT", "/api/admin/orders/ORD-1", {
        requestId: "REQ-3", groupBuyId: "GB1", customerId: "C1", pickupType: "自取",
        paymentStatus: "未付款", orderStatus: "已取消", phone: "0912", address: "", notes: "", items: []
    });
    assert.equal(cancelled.status, 200);
    stock = db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id = ?").get(lemon);
    assert.equal(stock.remaining_quantity, 10);
});

test("從檨檬改成蘆薈：蘆薈庫存不足時整筆訂單維持不變（原子交易，不留半套資料）", async () => {
    const db = createD1();
    const { lemon, aloe } = await seedPrilGroup(db);
    await configure(db, lemon, 10, 0, 2);
    await configure(db, aloe, 1, 0, 0); // 蘆薈只剩 1 組

    // C1 先訂檨檬 2 組
    const first = await call(db, "PUT", "/api/admin/orders/ORD-1", order("REQ-1", "C1", lemon, 2));
    assert.equal(first.status, 200);

    // 另一位客戶先把蘆薈買光
    const takeAloe = await call(db, "PUT", "/api/admin/orders/ORD-2", order("REQ-TAKE", "C2", aloe, 1));
    assert.equal(takeAloe.status, 200);

    // C1 想把檨檬改成蘆薈 3 組（蘆薈已售完）：只送蘆薈這筆新明細，後台會自動把沒送出的檨檬歸零，
    // 兩個口味的庫存異動都在同一個 batch 交易內，蘆薈庫存不足時應整筆失敗（rollback）。
    const swap = await call(db, "PUT", "/api/admin/orders/ORD-1", {
        requestId: "REQ-SWAP", groupBuyId: "GB1", customerId: "C1", pickupType: "自取",
        paymentStatus: "未付款", orderStatus: "新訂單", phone: "0912", address: "", notes: "",
        items: [{ productId: aloe, quantity: 3, unitPrice: 210 }]
    });
    assert.equal(swap.status, 409);

    // 檨檬訂單完全不變
    const lemonItem = db.database.prepare("SELECT quantity FROM order_items WHERE order_id = 'ORD-1' AND product_id = ?").get(lemon);
    assert.equal(lemonItem.quantity, 2);
    const lemonStock = db.database.prepare("SELECT remaining_quantity FROM group_buy_products WHERE product_id = ?").get(lemon);
    assert.equal(lemonStock.remaining_quantity, 8);

    // 蘆薈庫存也完全不變（沒有半套扣庫存）
    const aloeStock = db.database.prepare("SELECT remaining_quantity, sold_quantity FROM group_buy_products WHERE product_id = ?").get(aloe);
    assert.equal(aloeStock.remaining_quantity, 0);
    assert.equal(aloeStock.sold_quantity, 1);
    const aloeItems = db.database.prepare("SELECT COUNT(*) AS c FROM order_items WHERE order_id = 'ORD-1' AND product_id = ?").get(aloe);
    assert.equal(aloeItems.c, 0);
});

test("兩位客戶同時搶最後一組同一口味時不超賣（依序模擬 race）", async () => {
    const db = createD1();
    const { lemon } = await seedPrilGroup(db);
    await configure(db, lemon, 1, 0, 0);

    const first = await call(db, "PUT", "/api/admin/orders/ORD-1", order("REQ-1", "C1", lemon, 1));
    const second = await call(db, "PUT", "/api/admin/orders/ORD-2", order("REQ-2", "C2", lemon, 1));
    const results = [first.status, second.status].sort();
    assert.deepEqual(results, [200, 409]);
    const stock = db.database.prepare("SELECT remaining_quantity, sold_quantity FROM group_buy_products WHERE product_id = ?").get(lemon);
    assert.equal(stock.remaining_quantity, 0);
    assert.equal(stock.sold_quantity, 1);
});
