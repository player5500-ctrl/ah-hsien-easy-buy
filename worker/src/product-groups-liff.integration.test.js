// LIFF 客戶訂購頁「一個商品、多個口味」：客戶只看到一個主商品，展開後才看到各口味與各自庫存。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const liff = require("./liff.js");
const worker = require("./index.js");

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

const ENV = { LINE_LOGIN_CHANNEL_ID: "2010820387", LIFF_ID: "1234567890-abcdefgh", ADMIN_API_KEY: "test-admin" };

async function adminCall(db, method, pathname, body) {
    const response = await worker.fetch(new Request(`https://worker.test${pathname}`, {
        method,
        headers: { authorization: "Bearer test-admin", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body)
    }), { DB: db, ADMIN_API_KEY: "test-admin" }, {});
    let json = null;
    try { json = await response.json(); } catch (_error) { json = null; }
    return { status: response.status, json };
}

async function liffCall(db, method, pathAndQuery) {
    const request = new Request(`https://worker.test${pathAndQuery}`, { method });
    const url = new URL(request.url);
    const response = await liff.handleLiffRoutes(request, { ...ENV, DB: db }, url);
    return { status: response.status, json: await response.json() };
}

async function seedPrilGroup(db) {
    const created = await adminCall(db, "POST", "/api/product-groups", {
        requestId: "seed-1",
        name: "德國 Pril 洗碗精",
        description: "德國進口洗碗精濃縮配方",
        variants: [
            { variant_name: "檨檬", specs: "653ml x 3瓶", price: 210, pickup_price: 210, delivery_price: 225 },
            { variant_name: "蘆薈", specs: "750ml x 3瓶", price: 210, pickup_price: 210, delivery_price: 225 }
        ]
    });
    const [lemon, aloe] = created.json.variantIds;
    db.database.exec(`
        INSERT INTO group_buys (id, name, ends_at, status) VALUES ('GB1', '[TEST] Pril 團', '2099-12-31T15:59:59.000Z', 'open');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES ('GB1', '${lemon}'), ('GB1', '${aloe}');
    `);
    return { groupId: created.json.id, lemon, aloe };
}

test("LIFF 取得主商品所有口味：各口味獨立價格與庫存，回傳一次", async () => {
    const db = createD1();
    const { groupId, lemon, aloe } = await seedPrilGroup(db);
    await adminCall(db, "PUT", `/api/group-buys/GB1/stock/${lemon}`, { stockEnabled: true, incomingQuantity: 20, reservedQuantity: 0, lowStockThreshold: 3 });
    await adminCall(db, "PUT", `/api/group-buys/GB1/stock/${aloe}`, { stockEnabled: true, incomingQuantity: 15, reservedQuantity: 0, lowStockThreshold: 3 });

    const result = await liffCall(db, "GET", `/api/liff/group-buys/GB1/product-groups/${groupId}`);
    assert.equal(result.status, 200);
    assert.equal(result.json.productGroup.name, "德國 Pril 洗碗精");
    assert.equal(result.json.variants.length, 2);
    assert.equal(result.json.groupBuyStatus, "open");
    assert.equal(result.json.groupStockStatus, "open");

    const lemonVariant = result.json.variants.find(v => v.productId === lemon);
    assert.equal(lemonVariant.variantName, "檨檬");
    assert.equal(lemonVariant.specs, "653ml x 3瓶");
    assert.equal(lemonVariant.stock.remainingQuantity, 20);
    const aloeVariant = result.json.variants.find(v => v.productId === aloe);
    assert.equal(aloeVariant.stock.remainingQuantity, 15);
});

test("其中一個口味售完時，主商品狀態為部分售完，另一口味仍可下單", async () => {
    const db = createD1();
    const { groupId, lemon, aloe } = await seedPrilGroup(db);
    await adminCall(db, "PUT", `/api/group-buys/GB1/stock/${lemon}`, { stockEnabled: true, incomingQuantity: 20, reservedQuantity: 0, lowStockThreshold: 3 });
    await adminCall(db, "PUT", `/api/group-buys/GB1/stock/${aloe}`, { stockEnabled: true, incomingQuantity: 1, reservedQuantity: 0, lowStockThreshold: 0 });
    db.database.exec(`
        INSERT INTO customers (id, nickname) VALUES ('C1', '甲');
        INSERT INTO line_order_inbox (message_id, group_id, line_user_id, display_name, raw_message, normalized_message, message_time, status)
          VALUES ('M1', 'G1', 'U1', '甲', 'raw', 'raw', '2026-01-01T00:00:00.000Z', '已轉正式訂單');
        INSERT INTO orders (id, source_message_id, customer_id, status, group_buy_id) VALUES ('ORD-1', 'M1', 'C1', '新訂單', 'GB1');
    `);
    await adminCall(db, "PUT", "/api/admin/orders/ORD-1", {
        requestId: "req-take-aloe", groupBuyId: "GB1", customerId: "C1", pickupType: "自取",
        paymentStatus: "未付款", orderStatus: "新訂單", items: [{ productId: aloe, quantity: 1, unitPrice: 210 }]
    });

    const result = await liffCall(db, "GET", `/api/liff/group-buys/GB1/product-groups/${groupId}`);
    assert.equal(result.status, 200);
    assert.equal(result.json.groupStockStatus, "partial_sold_out");
    const aloeVariant = result.json.variants.find(v => v.productId === aloe);
    assert.equal(aloeVariant.stock.stockStatus, "sold_out");
    const lemonVariant = result.json.variants.find(v => v.productId === lemon);
    assert.equal(lemonVariant.stock.stockStatus, "in_stock");
});

test("停用的主商品／找不到的團購回 404", async () => {
    const db = createD1();
    const { groupId } = await seedPrilGroup(db);
    await adminCall(db, "PUT", `/api/product-groups/${groupId}`, { name: "德國 Pril 洗碗精", enabled: false });
    const disabled = await liffCall(db, "GET", `/api/liff/group-buys/GB1/product-groups/${groupId}`);
    assert.equal(disabled.status, 404);

    const missingGroupBuy = await liffCall(db, "GET", `/api/liff/group-buys/NOPE/product-groups/${groupId}`);
    assert.equal(missingGroupBuy.status, 404);
});
