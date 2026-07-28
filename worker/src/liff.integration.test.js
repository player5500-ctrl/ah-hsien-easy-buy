const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const liff = require("./liff.js");

// --- node:sqlite D1 shim（沿用 line-postback.integration.test.js 的骨架，補上 all()）---
class D1Statement {
    constructor(database, sql, args = []) {
        this.database = database;
        this.sql = sql;
        this.args = args;
    }

    bind(...args) {
        return new D1Statement(this.database, this.sql, args);
    }

    async run() {
        const result = this.database.prepare(this.sql).run(...this.args);
        return { meta: { changes: Number(result.changes || 0) } };
    }

    async first() {
        return this.database.prepare(this.sql).get(...this.args) || null;
    }

    async all() {
        return { results: this.database.prepare(this.sql).all(...this.args) };
    }
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

function seed(db) {
    db.database.exec(`
        INSERT INTO products (id, name, enabled, line_code, price, pickup_price, delivery_price, specs, unit) VALUES
            ('P1', '手工蛋捲', 1, 'P1', 180, 170, 200, '原味12入', '盒'),
            ('P2', '冰紅茶', 1, 'P2', 60, NULL, NULL, '1000ml', '瓶'),
            ('STOP', '停售品', 0, 'STOP', 90, 90, 90, '', '份');
        INSERT INTO group_buys (id, name, ends_at, status) VALUES
            ('GB1', '七月團購', '2099-07-31T15:59:59.000Z', 'open'),
            ('OLD', '已截止團購', '2020-01-01T00:00:00.000Z', 'open'),
            ('CLOSED', '已關團', '2099-07-31T15:59:59.000Z', 'closed');
        INSERT INTO group_buy_products (group_buy_id, product_id) VALUES
            ('GB1', 'P1'), ('GB1', 'P2'), ('GB1', 'STOP'), ('OLD', 'P1'), ('CLOSED', 'P1');
    `);
}

const ENV = { LINE_LOGIN_CHANNEL_ID: "2010820387", LIFF_ID: "1234567890-abcdefgh" };

// 先保留真實驗證函式，測試 stub 後於 afterEach 還原（require 回傳同一個被 mutate 的物件，不能靠它復原）。
const realVerifyLineIdToken = liff.verifyLineIdToken;

// 以 idToken 對應到已驗證的 LINE userId（sub）；等同 stub verifyLineIdToken。
function stubVerify(map) {
    liff.verifyLineIdToken = async (idToken) => {
        const entry = map[idToken];
        if (!entry) throw new liff.LiffAuthError();
        return entry;
    };
}

function makeRequest(method, pathAndQuery, { body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    return new Request(`https://worker${pathAndQuery}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
}

async function call(db, method, pathAndQuery, options = {}) {
    const request = makeRequest(method, pathAndQuery, options);
    const url = new URL(request.url);
    const response = await liff.handleLiffRoutes(request, { ...ENV, DB: db }, url);
    return response;
}

test.afterEach(() => {
    // 還原真實驗證，避免測試互相污染。
    liff.verifyLineIdToken = realVerifyLineIdToken;
});

test("有效 id_token → 使用驗證後的 userId 建立訂單；同時忽略前端偽造的 userId", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "王小明" } });

    const response = await call(db, "POST", "/api/liff/orders/set-quantity", {
        token: undefined,
        body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 2, pickupType: "自取", userId: "HACKER" }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.order.items.length, 1);
    assert.equal(payload.order.items[0].quantity, 2);

    // 訂單掛在驗證後的 sub 對應客戶，而非偽造的 HACKER。
    const customerId = await liff.stableId("LINE", "U1");
    const order = db.database.prepare("SELECT customer_id FROM orders LIMIT 1").get();
    assert.equal(order.customer_id, customerId);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM customers WHERE line_user_id = 'HACKER'").get().c, 0);
    db.database.close();
});

test("LIFF 庫存控管：確認成功才扣、重複點擊不重扣、超量回 409", async () => {
    const db = createD1();
    seed(db);
    stubVerify({
        "tok-U1": { sub: "U1", name: "甲" },
        "tok-U2": { sub: "U2", name: "乙" }
    });
    db.database.exec(`UPDATE group_buy_products SET
        incoming_quantity = 2, sellable_quantity = 2, remaining_quantity = 2,
        low_stock_threshold = 1, stock_enabled = 1
        WHERE group_buy_id = 'GB1' AND product_id = 'P1'`);

    const payload = { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "自取" };
    const first = await call(db, "POST", "/api/liff/orders/set-quantity", { body: payload });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).stock.remainingQuantity, 1);

    const repeatedClick = await call(db, "POST", "/api/liff/orders/set-quantity", { body: payload });
    assert.equal(repeatedClick.status, 200);
    assert.equal((await repeatedClick.json()).stock.remainingQuantity, 1);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get().count, 1);

    const tooMany = await call(db, "POST", "/api/liff/orders/set-quantity", {
        body: { ...payload, idToken: "tok-U2", quantity: 2 }
    });
    assert.equal(tooMany.status, 409);
    assert.equal((await tooMany.json()).error, "INSUFFICIENT_STOCK");
    assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
    assert.equal(db.database.prepare(`SELECT remaining_quantity FROM group_buy_products
        WHERE group_buy_id = 'GB1' AND product_id = 'P1'`).get().remaining_quantity, 1);
    db.database.close();
});

test("無效 id_token → 401 且不寫入任何資料（走真實 verify + 假 fetch）", async () => {
    const db = createD1();
    seed(db);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad token", { status: 400 });
    try {
        const response = await call(db, "POST", "/api/liff/orders/set-quantity", {
            body: { idToken: "whatever", groupBuyId: "GB1", productId: "P1", quantity: 2, pickupType: "自取" }
        });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error, "無法驗證您的 LINE 身分");
        assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 0);
        assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM order_items").get().c, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
    db.database.close();
});

test("verifyLineIdToken：aud 相符且未過期→回傳 sub；aud 不符→丟出 LiffAuthError", async () => {
    const originalFetch = globalThis.fetch;
    const future = Math.floor(Date.now() / 1000) + 3600;
    try {
        globalThis.fetch = async (endpoint, options) => {
            assert.equal(endpoint, "https://api.line.me/oauth2/v2.1/verify");
            assert.match(options.body, /id_token=good/);
            assert.match(options.body, /client_id=2010820387/);
            return new Response(JSON.stringify({ aud: "2010820387", exp: future, sub: "U9", name: "阿九" }), { status: 200 });
        };
        const result = await liff.verifyLineIdToken("good", ENV);
        assert.deepEqual(result, { sub: "U9", name: "阿九" });

        globalThis.fetch = async () => new Response(JSON.stringify({ aud: "OTHER", exp: future, sub: "U9" }), { status: 200 });
        await assert.rejects(() => liff.verifyLineIdToken("good", ENV), (error) => error instanceof liff.LiffAuthError);

        globalThis.fetch = async () => new Response(JSON.stringify({ aud: "2010820387", exp: 1, sub: "U9" }), { status: 200 });
        await assert.rejects(() => liff.verifyLineIdToken("good", ENV), (error) => error instanceof liff.LiffAuthError);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("set 1 再 set 3 → 數量為 3（覆寫非累加），且仍是單一 order_item 列", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "小明" } });

    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "自取" } });
    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "自取" } });
    const after = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 3, pickupType: "自取" } });
    assert.equal(after.status, 200);

    const rows = db.database.prepare("SELECT quantity, amount FROM order_items WHERE product_id = 'P1'").all();
    assert.equal(rows.length, 1, "重複 confirm 不得產生重複 order_item 列");
    assert.equal(rows[0].quantity, 3);
    assert.equal(rows[0].amount, 510); // 自取價 170 * 3
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 1);
    db.database.close();
});

test("cancel-item → 品項消失、訂單總額與狀態更新；統計數量隨之下降", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "小明" } });

    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 2, pickupType: "自取" } });
    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P2", quantity: 5, pickupType: "自取" } });

    const before = await (await call(db, "GET", "/api/liff/group-buys/GB1/products/P1")).json();
    assert.equal(before.stats.totalQuantity, 7);
    assert.equal(before.stats.buyerCount, 1);

    const cancelled = await call(db, "POST", "/api/liff/orders/cancel-item", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1" } });
    assert.equal(cancelled.status, 200);
    const payload = await cancelled.json();
    assert.equal(payload.order.items.length, 1);
    assert.equal(payload.order.items[0].productId, "P2");
    assert.equal(payload.order.totalAmount, 300); // P2 自取回退 price 60 * 5
    assert.equal(payload.stats.totalQuantity, 5);
    assert.equal(payload.stats.buyerCount, 1);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM order_items WHERE product_id = 'P1'").get().c, 0);
    assert.equal(db.database.prepare("SELECT status FROM orders LIMIT 1").get().status, "新訂單");
    db.database.close();
});

test("兩位不同客戶 → buyerCount=2；其中一位整單取消後被排除，狀態為已取消", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "甲" }, "tok-U2": { sub: "U2", name: "乙" } });

    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 2, pickupType: "自取" } });
    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U2", groupBuyId: "GB1", productId: "P1", quantity: 3, pickupType: "外送", address: "台北市信義區信義路五段7號" } });

    let stats = (await (await call(db, "GET", "/api/liff/group-buys/GB1/products/P1")).json()).stats;
    assert.equal(stats.buyerCount, 2);
    assert.equal(stats.totalQuantity, 5);
    assert.deepEqual(stats.perProduct, [{ productId: "P1", quantity: 5 }]);

    const cancelled = await call(db, "POST", "/api/liff/orders/cancel-order", { body: { idToken: "tok-U2", groupBuyId: "GB1" } });
    assert.equal(cancelled.status, 200);
    stats = (await cancelled.json()).stats;
    assert.equal(stats.buyerCount, 1);
    assert.equal(stats.totalQuantity, 2);

    const u2CustomerId = await liff.stableId("LINE", "U2");
    const u2Order = db.database.prepare("SELECT status FROM orders WHERE customer_id = ?").get(u2CustomerId);
    assert.equal(u2Order.status, "已取消");
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ?)").get(u2CustomerId).c, 0);
    // 稽核紀錄保留（set 1 筆 + cancel 1 筆）
    assert.ok(db.database.prepare("SELECT COUNT(*) AS c FROM order_change_logs WHERE customer_id = ?").get(u2CustomerId).c >= 2);
    db.database.close();
});

test("my-order 只回傳呼叫者本人的訂單（以驗證後 sub 為鍵）", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "甲" }, "tok-U2": { sub: "U2", name: "乙" } });

    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 2, pickupType: "自取" } });
    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U2", groupBuyId: "GB1", productId: "P2", quantity: 4, pickupType: "外送", address: "新北市板橋區文化路一段1號" } });

    const mineU1 = await (await call(db, "GET", "/api/liff/my-order?groupBuyId=GB1", { token: "tok-U1" })).json();
    assert.equal(mineU1.order.items.length, 1);
    assert.equal(mineU1.order.items[0].productId, "P1");
    assert.equal(mineU1.order.pickupType, "自取");

    const mineU2 = await (await call(db, "GET", "/api/liff/my-order?groupBuyId=GB1", { token: "tok-U2" })).json();
    assert.equal(mineU2.order.items.length, 1);
    assert.equal(mineU2.order.items[0].productId, "P2");

    // 沒訂單的使用者拿到空訂單。
    stubVerify({ "tok-U3": { sub: "U3", name: "丙" } });
    const mineU3 = await (await call(db, "GET", "/api/liff/my-order?groupBuyId=GB1", { token: "tok-U3" })).json();
    assert.deepEqual(mineU3.order, { items: [], pickupType: null, totalAmount: 0, status: null, address: null, hasAddress: false });
    db.database.close();
});

test("暫存客戶（未綁定 line_user_id）仍保留其訂單", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-new": { sub: "Unew", name: "新客" } });

    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-new", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "自取" } });
    const customer = db.database.prepare("SELECT id, profile_status FROM customers WHERE line_user_id = 'Unew'").get();
    assert.ok(customer);
    assert.equal(customer.profile_status, "pending");
    assert.equal(customer.id, await liff.stableId("LINE", "Unew"));
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM order_items").get().c, 1);
    db.database.close();
});

test("已關團／已截止團購 → set-quantity 回 409；找不到商品 → 404", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "甲" } });

    const expired = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "OLD", productId: "P1", quantity: 1, pickupType: "自取" } });
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).error, "此團購已截止");

    const closed = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "CLOSED", productId: "P1", quantity: 1, pickupType: "自取" } });
    assert.equal(closed.status, 409);

    const unknown = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "NOPE", quantity: 1, pickupType: "自取" } });
    assert.equal(unknown.status, 404);

    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 0);
    db.database.close();
});

test("雙價：自取用 pickup_price、外送用 delivery_price、缺值回退 price", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-A": { sub: "A", name: "甲" }, "tok-B": { sub: "B", name: "乙" }, "tok-C": { sub: "C", name: "丙" } });

    const pickup = await (await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-A", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "自取" } })).json();
    assert.equal(pickup.order.items[0].unitPrice, 170);

    const delivery = await (await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-B", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "外送", address: "台中市西屯區台灣大道三段99號" } })).json();
    assert.equal(delivery.order.items[0].unitPrice, 200);

    const fallback = await (await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-C", groupBuyId: "GB1", productId: "P2", quantity: 1, pickupType: "自取" } })).json();
    assert.equal(fallback.order.items[0].unitPrice, 60);
    db.database.close();
});

test("config 回傳非機密 LIFF_ID；非 JSON POST 被拒；缺 idToken → 401", async () => {
    const db = createD1();
    seed(db);
    stubVerify({});

    const config = await call(db, "GET", "/api/liff/config");
    assert.equal(config.status, 200);
    assert.equal((await config.json()).liffId, "1234567890-abcdefgh");

    // 非 application/json 的 POST → 415
    const notJson = new Request("https://worker/api/liff/session", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    const notJsonResponse = await liff.handleLiffRoutes(notJson, { ...ENV, DB: db }, new URL(notJson.url));
    assert.equal(notJsonResponse.status, 415);

    // 未知 token（stubVerify 空表）→ 401
    const badSession = await call(db, "POST", "/api/liff/session", { body: { idToken: "unknown" } });
    assert.equal(badSession.status, 401);
    db.database.close();
});

test("(a) 外送 未帶地址且無既有地址 → 409『外送地址尚未設定』，不寫入任何資料", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "甲" } });

    const res = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "外送" } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "外送地址尚未設定");
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 0);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM order_items").get().c, 0);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM customers").get().c, 0);

    // 只帶空白地址亦視為未設定 → 409，同樣不寫入。
    const blank = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "外送", address: "   " } });
    assert.equal(blank.status, 409);
    assert.equal(db.database.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 0);
    db.database.close();
});

test("(b) 外送 帶地址 → 訂單存為外送且 customers.address 更新；後續 my-order 回傳地址與 hasAddress=true", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "甲" } });

    const res = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 2, pickupType: "外送", address: "  台北市信義區信義路五段7號  " } });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.order.pickupType, "外送");
    assert.equal(payload.order.address, "台北市信義區信義路五段7號"); // 已 trim
    assert.equal(payload.order.hasAddress, true);

    const customerId = await liff.stableId("LINE", "U1");
    const savedAddress = db.database.prepare("SELECT address FROM customers WHERE id = ?").get(customerId).address;
    assert.equal(savedAddress, "台北市信義區信義路五段7號");
    assert.equal(db.database.prepare("SELECT pickup_type FROM orders WHERE customer_id = ?").get(customerId).pickup_type, "外送");

    const mine = await (await call(db, "GET", "/api/liff/my-order?groupBuyId=GB1", { token: "tok-U1" })).json();
    assert.equal(mine.order.address, "台北市信義區信義路五段7號");
    assert.equal(mine.order.hasAddress, true);

    // session 回應也帶本人地址
    const session = await (await call(db, "POST", "/api/liff/session", { body: { idToken: "tok-U1" } })).json();
    assert.equal(session.address, "台北市信義區信義路五段7號");
    assert.equal(session.hasAddress, true);
    db.database.close();
});

test("(c) 外送 第二筆未帶地址 → 沿用既有 customers.address，成功", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "甲" } });

    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "外送", address: "高雄市前鎮區中山二路2號" } });
    // 第二筆不帶 address，仍應成功並沿用既有地址
    const res = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P2", quantity: 3, pickupType: "外送" } });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.order.pickupType, "外送");
    assert.equal(payload.order.address, "高雄市前鎮區中山二路2號");
    assert.equal(payload.order.hasAddress, true);

    const customerId = await liff.stableId("LINE", "U1");
    assert.equal(db.database.prepare("SELECT address FROM customers WHERE id = ?").get(customerId).address, "高雄市前鎮區中山二路2號");
    db.database.close();
});

test("(d) 自取 未帶地址 → 仍成功；帶地址則選填保存", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "甲" }, "tok-U2": { sub: "U2", name: "乙" } });

    const res = await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "自取" } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).order.pickupType, "自取");
    const u1 = await liff.stableId("LINE", "U1");
    assert.equal(db.database.prepare("SELECT address FROM customers WHERE id = ?").get(u1).address, null);

    // 自取仍可選填保存地址
    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U2", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "自取", address: "桃園市中壢區中央西路一段1號" } });
    const u2 = await liff.stableId("LINE", "U2");
    assert.equal(db.database.prepare("SELECT address FROM customers WHERE id = ?").get(u2).address, "桃園市中壢區中央西路一段1號");
    db.database.close();
});

test("(e) 地址絕不出現在匿名商品／統計回應中", async () => {
    const db = createD1();
    seed(db);
    stubVerify({ "tok-U1": { sub: "U1", name: "甲" } });

    await call(db, "POST", "/api/liff/orders/set-quantity", { body: { idToken: "tok-U1", groupBuyId: "GB1", productId: "P1", quantity: 1, pickupType: "外送", address: "台南市東區中華東路一段1號" } });

    const publicResponse = await (await call(db, "GET", "/api/liff/group-buys/GB1/products/P1")).json();
    const serialized = JSON.stringify(publicResponse);
    assert.equal(/台南市東區中華東路一段1號/.test(serialized), false);
    assert.equal(Object.prototype.hasOwnProperty.call(publicResponse, "address"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(publicResponse.stats, "address"), false);
    assert.equal(publicResponse.stats.perProduct.some(row => Object.prototype.hasOwnProperty.call(row, "address")), false);
    db.database.close();
});
