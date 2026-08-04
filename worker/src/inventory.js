class InventoryHttpError extends Error {
    constructor(status, code, message, details = {}) {
        super(message);
        this.name = "InventoryHttpError";
        this.status = status;
        this.code = code;
        Object.assign(this, details);
    }
}

function integer(value, label, minimum = 0) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum) {
        throw new InventoryHttpError(400, "INVALID_STOCK_VALUE", `${label}必須是 ${minimum} 以上的整數`);
    }
    return parsed;
}

function stockStatus(remaining, threshold, enabled = true) {
    if (!enabled) return "in_stock";
    if (remaining <= 0) return "sold_out";
    if (remaining <= threshold) return "low_stock";
    return "in_stock";
}

function publicStock(row) {
    if (!row) return null;
    return {
        groupBuyId: row.group_buy_id,
        productId: row.product_id,
        productCode: row.line_code || row.product_id,
        productName: row.product_name || row.name || "",
        specs: row.specs || "",
        unit: row.unit || "份",
        variantName: row.variant_name || null,
        productGroupId: row.product_group_id || null,
        stockEnabled: Boolean(row.stock_enabled),
        incomingQuantity: Number(row.incoming_quantity || 0),
        reservedQuantity: Number(row.reserved_quantity || 0),
        sellableQuantity: Number(row.sellable_quantity || 0),
        soldQuantity: Number(row.sold_quantity || 0),
        remainingQuantity: Number(row.remaining_quantity || 0),
        lowStockThreshold: Number(row.low_stock_threshold ?? 5),
        stockStatus: row.stock_status || stockStatus(
            Number(row.remaining_quantity || 0),
            Number(row.low_stock_threshold ?? 5),
            Boolean(row.stock_enabled)
        )
    };
}

function stockSelectSql(extraWhere = "") {
    return `SELECT gbp.*, p.line_code, p.name AS product_name, p.specs, p.unit,
            p.variant_name, p.product_group_id
        FROM group_buy_products gbp
        JOIN products p ON p.id = gbp.product_id
        ${extraWhere}`;
}

async function getStock(env, groupBuyId, productId) {
    return env.DB.prepare(`${stockSelectSql("WHERE gbp.group_buy_id = ? AND gbp.product_id = ?")} LIMIT 1`)
        .bind(groupBuyId, productId).first();
}

async function listStock(env, groupBuyId) {
    const result = await env.DB.prepare(`${stockSelectSql("WHERE gbp.group_buy_id = ?")}
        ORDER BY p.line_code, p.id`).bind(groupBuyId).all();
    return result.results.map(publicStock);
}

function movementType(sourceType, before, after, restoringOrder = false) {
    if (before === 0 && after > 0) {
        if (restoringOrder) return "order_restored";
        if (sourceType === "liff") return "liff_order_confirmed";
        if (sourceType === "line_postback" || sourceType === "line_text") return "line_order_confirmed";
        if (sourceType === "excel_import") return "excel_import";
        return "order_created";
    }
    if (after === 0 && before > 0) return "order_cancelled";
    if (after > before) return "order_increased";
    return "order_decreased";
}

function changeAction(before, after) {
    if (after === 0) return "cancel_item";
    if (before === 0) return "create";
    return after > before ? "increase" : "decrease";
}

function guardStatement(env, guardId, orderId, groupBuyId, productId, before, delta) {
    return env.DB.prepare(`INSERT INTO inventory_tx_guards (id, valid)
        SELECT ?, CASE WHEN
            COALESCE((SELECT quantity FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1), 0) = ?
            AND EXISTS (
                SELECT 1 FROM group_buy_products
                WHERE group_buy_id = ? AND product_id = ?
                AND (
                    stock_enabled = 0
                    OR (
                        sold_quantity + ? >= 0
                        AND (? <= 0 OR remaining_quantity >= ?)
                    )
                )
            )
        THEN 1 ELSE 0 END`)
        .bind(guardId, orderId, productId, before, groupBuyId, productId, delta, delta, delta);
}

function updateStockStatement(env, groupBuyId, productId, delta) {
    return env.DB.prepare(`UPDATE group_buy_products
        SET sold_quantity = sold_quantity + ?,
            remaining_quantity = remaining_quantity - ?,
            stock_status = CASE
                WHEN remaining_quantity - ? <= 0 THEN 'sold_out'
                WHEN remaining_quantity - ? <= low_stock_threshold THEN 'low_stock'
                ELSE 'in_stock'
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE group_buy_id = ? AND product_id = ? AND stock_enabled = 1`)
        .bind(delta, delta, delta, delta, groupBuyId, productId);
}

// stock（getStock/stockSelectSql 的 JOIN 結果）帶有下單當下的商品名稱／口味名稱／規格，
// 只在「第一次建立這筆明細」時寫入 *_snapshot；之後改數量／改口味只更新既有明細，
// 不會覆寫 snapshot，避免未來商品或口味改名後舊訂單內容跟著改變（見需求文件第十節）。
function itemStatement(env, orderId, change, stock) {
    if (change.quantity === 0) {
        return env.DB.prepare("DELETE FROM order_items WHERE order_id = ? AND product_id = ?")
            .bind(orderId, change.productId);
    }
    return env.DB.prepare(`INSERT INTO order_items
        (order_id, product_code, product_id, quantity, unit_price, amount, item_status, updated_at,
         product_name_snapshot, variant_name_snapshot, specs_snapshot)
        VALUES (?, ?, ?, ?, ?, ? * ?, 'active', CURRENT_TIMESTAMP, ?, ?, ?)
        ON CONFLICT(order_id, product_id) DO UPDATE SET
            quantity = excluded.quantity,
            product_code = excluded.product_code,
            unit_price = excluded.unit_price,
            amount = excluded.amount,
            item_status = 'active',
            updated_at = CURRENT_TIMESTAMP`)
        .bind(
            orderId,
            change.productCode || change.productId,
            change.productId,
            change.quantity,
            change.unitPrice,
            change.unitPrice,
            change.quantity,
            stock?.product_name || null,
            stock?.variant_name || null,
            stock?.specs || null
        );
}

function inventoryMovementStatement(env, options) {
    const {
        id, groupBuyId, productId, orderId, movement, delta,
        sourceType, notes, requestKey
    } = options;
    return env.DB.prepare(`INSERT INTO inventory_movements
        (id, group_buy_id, product_id, order_id, order_item_id, movement_type,
         quantity_change, quantity_before, quantity_after, source_type, notes, request_key)
        SELECT ?, ?, ?, ?, (
            SELECT id FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1
        ), ?, ?, remaining_quantity + ?, remaining_quantity, ?, ?, ?
        FROM group_buy_products
        WHERE group_buy_id = ? AND product_id = ? AND stock_enabled = 1 AND ? <> 0`)
        .bind(
            id, groupBuyId, productId, orderId, orderId, productId,
            movement, -delta, delta, sourceType, notes || null, requestKey || null,
            groupBuyId, productId, delta
        );
}

function orderChangeStatement(env, options) {
    return env.DB.prepare(`INSERT INTO order_change_logs
        (id, order_id, customer_id, group_buy_id, product_id, action,
         quantity_before, quantity_after, source_type, webhook_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
            crypto.randomUUID(),
            options.orderId,
            options.customerId,
            options.groupBuyId,
            options.productId,
            changeAction(options.before, options.after),
            options.before,
            options.after,
            options.sourceType,
            options.webhookEventId || null
        );
}

function recomputeOrderStatement(env, orderId, activeStatus, pickupType) {
    return env.DB.prepare(`UPDATE orders
        SET total_amount = COALESCE((
                SELECT SUM(amount) FROM order_items
                WHERE order_id = ? AND item_status = 'active' AND quantity > 0
            ), 0),
            status = CASE
                WHEN EXISTS (
                    SELECT 1 FROM order_items
                    WHERE order_id = ? AND item_status = 'active' AND quantity > 0
                ) THEN ?
                ELSE '已取消'
            END,
            pickup_type = COALESCE(?, pickup_type),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`)
        .bind(orderId, orderId, activeStatus || "新訂單", pickupType || null, orderId);
}

async function prepareOrderMutation(env, options) {
    const {
        orderId, groupBuyId, customerId, changes, sourceType,
        webhookEventId, notes
    } = options;
    if (!orderId || !groupBuyId || !customerId) {
        throw new InventoryHttpError(400, "INVALID_ORDER", "訂單、團購與客戶資料不完整");
    }
    if (!Array.isArray(changes) || !changes.length) {
        throw new InventoryHttpError(400, "INVALID_ORDER_ITEMS", "訂單至少需要一項商品異動");
    }
    const duplicateIds = new Set();
    for (const change of changes) {
        change.productId = String(change.productId || "").trim();
        if (!change.productId || duplicateIds.has(change.productId)) {
            throw new InventoryHttpError(400, "INVALID_ORDER_ITEMS", "訂單商品不可空白或重複");
        }
        duplicateIds.add(change.productId);
        change.quantity = integer(change.quantity, "商品數量");
        change.unitPrice = integer(change.unitPrice ?? 0, "商品單價");
    }

    const existingOrder = await env.DB.prepare("SELECT status FROM orders WHERE id = ? LIMIT 1")
        .bind(orderId).first();
    const currentRows = (await env.DB.prepare(`SELECT product_id, quantity
        FROM order_items WHERE order_id = ?`).bind(orderId).all()).results;
    const current = new Map(currentRows.map(row => [row.product_id, Number(row.quantity || 0)]));
    const prepared = [];
    const guardIds = [];
    const deltas = [];
    for (const change of changes) {
        const stock = await getStock(env, groupBuyId, change.productId);
        if (!stock) {
            throw new InventoryHttpError(409, "PRODUCT_NOT_IN_GROUP", `商品 ${change.productId} 不屬於此團購`);
        }
        const before = current.get(change.productId) || 0;
        const delta = change.quantity - before;
        const guardId = crypto.randomUUID();
        guardIds.push(guardId);
        deltas.push({ change, stock, before, delta });
        prepared.push(guardStatement(env, guardId, orderId, groupBuyId, change.productId, before, delta));
        if (delta !== 0) prepared.push(updateStockStatement(env, groupBuyId, change.productId, delta));
        prepared.push(itemStatement(env, orderId, change, stock));
        if (delta !== 0) {
            const movement = movementType(sourceType, before, change.quantity, existingOrder?.status === "已取消");
            prepared.push(inventoryMovementStatement(env, {
                id: crypto.randomUUID(),
                groupBuyId,
                productId: change.productId,
                orderId,
                movement,
                delta,
                sourceType,
                notes,
                requestKey: options.requestKeyPrefix ? `${options.requestKeyPrefix}:${change.productId}` : null
            }));
        }
        // 保留既有稽核語意：同一數量的再次確認仍記 order_change_logs，
        // 但 delta=0 不寫 inventory_movements，也不會重複扣庫存。
        prepared.push(orderChangeStatement(env, {
            orderId, customerId, groupBuyId, productId: change.productId,
            before, after: change.quantity, sourceType, webhookEventId
        }));
    }
    return {
        statements: prepared,
        guardIds,
        deltas,
        existingOrder,
        recompute: recomputeOrderStatement(env, orderId, options.activeStatus, options.pickupType)
    };
}

function isGuardFailure(error) {
    return /CHECK constraint failed:?\s*(inventory_tx_guards|valid)/i.test(String(error?.message || ""));
}

function isDuplicateRequest(error) {
    return /UNIQUE constraint failed:\s*order_mutation_requests\.request_id/i.test(String(error?.message || ""));
}

async function explainMutationConflict(env, prepared) {
    for (const entry of prepared.deltas) {
        const latest = await getStock(env, entry.stock.group_buy_id, entry.change.productId);
        if (latest && latest.stock_enabled && entry.delta > Number(latest.remaining_quantity || 0)) {
            const remaining = Number(latest.remaining_quantity || 0);
            throw new InventoryHttpError(
                409,
                remaining <= 0 ? "SOLD_OUT" : "INSUFFICIENT_STOCK",
                remaining <= 0 ? "本商品已售完" : "商品剩餘數量不足",
                { remainingQuantity: remaining, requestedQuantity: entry.change.quantity }
            );
        }
    }
    throw new InventoryHttpError(409, "ORDER_CONFLICT", "訂單剛剛已被更新，請重新整理後再試");
}

async function executePreparedMutations(env, entries, options = {}) {
    const statements = [];
    if (options.requestId) {
        statements.push(env.DB.prepare(`INSERT INTO order_mutation_requests
            (request_id, source_type, order_id) VALUES (?, ?, ?)`)
            .bind(options.requestId, options.sourceType, options.orderId || null));
    }
    for (const entry of entries) {
        statements.push(...(entry.options.preStatements || []));
        statements.push(...entry.prepared.statements);
        statements.push(entry.prepared.recompute);
        statements.push(...(entry.options.postStatements || []));
    }
    for (const entry of entries) {
        for (const guardId of entry.prepared.guardIds) {
            statements.push(env.DB.prepare("DELETE FROM inventory_tx_guards WHERE id = ?").bind(guardId));
        }
    }
    try {
        await env.DB.batch(statements);
        return { applied: true, duplicate: false };
    } catch (error) {
        if (options.requestId && isDuplicateRequest(error)) return { applied: false, duplicate: true };
        if (isGuardFailure(error)) {
            for (const entry of entries) {
                try {
                    await explainMutationConflict(env, entry.prepared);
                } catch (conflict) {
                    if (conflict.code !== "ORDER_CONFLICT") throw conflict;
                }
            }
            throw new InventoryHttpError(409, "ORDER_CONFLICT", "訂單剛剛已被更新，請重新整理後再試");
        }
        throw error;
    }
}

async function executeOrderMutation(env, options) {
    const prepared = await prepareOrderMutation(env, options);
    return executePreparedMutations(env, [{ prepared, options }], options);
}

async function configureStock(env, groupBuyId, productId, payload) {
    const incoming = integer(payload.incomingQuantity ?? payload.incoming_quantity ?? 0, "進貨數量");
    const reserved = integer(payload.reservedQuantity ?? payload.reserved_quantity ?? 0, "保留數量");
    const threshold = integer(payload.lowStockThreshold ?? payload.low_stock_threshold ?? 5, "低庫存門檻");
    const enabled = Boolean(payload.stockEnabled ?? payload.stock_enabled);
    if (reserved > incoming) {
        throw new InventoryHttpError(400, "INVALID_STOCK_VALUE", "保留數量不可大於進貨數量");
    }
    const existing = await getStock(env, groupBuyId, productId);
    if (!existing) throw new InventoryHttpError(404, "PRODUCT_NOT_IN_GROUP", "找不到團購商品");
    const soldRow = await env.DB.prepare(`SELECT COALESCE(SUM(oi.quantity), 0) AS sold
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.group_buy_id = ? AND oi.product_id = ?
          AND o.status <> '已取消' AND oi.item_status = 'active' AND oi.quantity > 0`)
        .bind(groupBuyId, productId).first();
    const sold = Number(soldRow?.sold || 0);
    const sellable = incoming - reserved;
    if (enabled && sellable < sold) {
        throw new InventoryHttpError(409, "SELLABLE_BELOW_SOLD", "可賣數量不可小於目前有效訂單已售數量", {
            soldQuantity: sold,
            sellableQuantity: sellable
        });
    }
    const remaining = Math.max(0, sellable - sold);
    const status = stockStatus(remaining, threshold, enabled);
    const beforeRemaining = Number(existing.remaining_quantity || 0);
    const guardId = crypto.randomUUID();
    const statements = [
        env.DB.prepare(`INSERT INTO inventory_tx_guards (id, valid)
            SELECT ?, CASE WHEN EXISTS (
                SELECT 1 FROM group_buy_products gbp
                WHERE gbp.group_buy_id = ? AND gbp.product_id = ?
                  AND gbp.incoming_quantity = ? AND gbp.reserved_quantity = ?
                  AND gbp.sold_quantity = ? AND gbp.stock_enabled = ?
                  AND ? = (
                    SELECT COALESCE(SUM(oi.quantity), 0)
                    FROM orders o JOIN order_items oi ON oi.order_id = o.id
                    WHERE o.group_buy_id = gbp.group_buy_id AND oi.product_id = gbp.product_id
                      AND o.status <> '已取消' AND oi.item_status = 'active' AND oi.quantity > 0
                  )
            ) THEN 1 ELSE 0 END`)
            .bind(
                guardId, groupBuyId, productId,
                existing.incoming_quantity, existing.reserved_quantity,
                existing.sold_quantity, existing.stock_enabled, sold
            ),
        env.DB.prepare(`UPDATE group_buy_products SET
            incoming_quantity = ?, reserved_quantity = ?, sellable_quantity = ?,
            sold_quantity = ?, remaining_quantity = ?, low_stock_threshold = ?,
            stock_status = ?, stock_enabled = ?, updated_at = CURRENT_TIMESTAMP
            WHERE group_buy_id = ? AND product_id = ?`)
            .bind(incoming, reserved, sellable, sold, remaining, threshold, status, enabled ? 1 : 0, groupBuyId, productId)
    ];
    if (enabled && (!existing.stock_enabled || beforeRemaining !== remaining)) {
        statements.push(env.DB.prepare(`INSERT INTO inventory_movements
            (id, group_buy_id, product_id, movement_type, quantity_change,
             quantity_before, quantity_after, source_type, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?)`)
            .bind(
                crypto.randomUUID(), groupBuyId, productId,
                existing.stock_enabled ? "admin_adjustment" : "initial_stock",
                remaining - beforeRemaining, beforeRemaining, remaining,
                String(payload.notes || "設定團購商品庫存").trim().slice(0, 500)
            ));
    }
    statements.push(env.DB.prepare("DELETE FROM inventory_tx_guards WHERE id = ?").bind(guardId));
    try {
        await env.DB.batch(statements);
    } catch (error) {
        if (isGuardFailure(error)) {
            throw new InventoryHttpError(409, "STOCK_CONFLICT", "訂單或庫存剛剛已更新，請重新整理後再試");
        }
        throw error;
    }
    return publicStock(await getStock(env, groupBuyId, productId));
}

async function adjustStock(env, groupBuyId, productId, payload) {
    const adjustment = integer(Math.abs(Number(payload.quantityChange ?? payload.quantity_change)), "調整數量", 1)
        * (Number(payload.quantityChange ?? payload.quantity_change) < 0 ? -1 : 1);
    const reason = String(payload.reason || "").trim().slice(0, 500);
    if (!reason) throw new InventoryHttpError(400, "ADJUSTMENT_REASON_REQUIRED", "請填寫調整原因");
    const before = await getStock(env, groupBuyId, productId);
    if (!before) throw new InventoryHttpError(404, "PRODUCT_NOT_IN_GROUP", "找不到團購商品");
    if (!before.stock_enabled) throw new InventoryHttpError(409, "STOCK_NOT_ENABLED", "此團購商品尚未啟用庫存控管");
    const nextIncoming = Number(before.incoming_quantity) + adjustment;
    const nextSellable = nextIncoming - Number(before.reserved_quantity);
    const nextRemaining = nextSellable - Number(before.sold_quantity);
    if (nextIncoming < 0 || nextSellable < Number(before.sold_quantity)) {
        throw new InventoryHttpError(409, "ADJUSTMENT_TOO_LOW", "調整後可賣數量不可小於目前已售數量");
    }
    const nextStatus = stockStatus(nextRemaining, Number(before.low_stock_threshold), true);
    const guardId = crypto.randomUUID();
    try {
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO inventory_tx_guards (id, valid)
            SELECT ?, CASE WHEN EXISTS (
                SELECT 1 FROM group_buy_products
                WHERE group_buy_id = ? AND product_id = ? AND stock_enabled = 1
                  AND incoming_quantity = ? AND remaining_quantity = ?
            ) THEN 1 ELSE 0 END`)
            .bind(guardId, groupBuyId, productId, before.incoming_quantity, before.remaining_quantity),
        env.DB.prepare(`UPDATE group_buy_products SET incoming_quantity = ?, sellable_quantity = ?,
            remaining_quantity = ?, stock_status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE group_buy_id = ? AND product_id = ? AND stock_enabled = 1
              AND incoming_quantity = ? AND remaining_quantity = ?`)
            .bind(nextIncoming, nextSellable, nextRemaining, nextStatus, groupBuyId, productId,
                before.incoming_quantity, before.remaining_quantity),
        env.DB.prepare(`INSERT INTO inventory_movements
            (id, group_buy_id, product_id, movement_type, quantity_change,
             quantity_before, quantity_after, source_type, notes)
            VALUES (?, ?, ?, 'admin_adjustment', ?, ?, ?, 'admin', ?)`)
            .bind(crypto.randomUUID(), groupBuyId, productId, adjustment,
                before.remaining_quantity, nextRemaining, reason),
            env.DB.prepare("DELETE FROM inventory_tx_guards WHERE id = ?").bind(guardId)
        ]);
    } catch (error) {
        if (isGuardFailure(error)) {
            throw new InventoryHttpError(409, "STOCK_CONFLICT", "庫存剛剛已被調整，請重新整理後再試");
        }
        throw error;
    }
    return publicStock(await getStock(env, groupBuyId, productId));
}

async function reconciliationPreview(env, groupBuyId) {
    const result = await env.DB.prepare(`${stockSelectSql("WHERE gbp.group_buy_id = ?")}
        ORDER BY p.line_code, p.id`).bind(groupBuyId).all();
    const rows = [];
    for (const row of result.results) {
        const actualRow = await env.DB.prepare(`SELECT COALESCE(SUM(oi.quantity), 0) AS sold
            FROM orders o JOIN order_items oi ON oi.order_id = o.id
            WHERE o.group_buy_id = ? AND oi.product_id = ?
              AND o.status <> '已取消' AND oi.item_status = 'active' AND oi.quantity > 0`)
            .bind(groupBuyId, row.product_id).first();
        const actualSold = Number(actualRow?.sold || 0);
        rows.push({
            ...publicStock(row),
            actualSoldQuantity: actualSold,
            difference: actualSold - Number(row.sold_quantity || 0)
        });
    }
    return rows;
}

async function applyReconciliation(env, groupBuyId, payload) {
    const confirmed = payload?.confirmed === true;
    if (!confirmed) throw new InventoryHttpError(400, "CONFIRMATION_REQUIRED", "請先確認庫存差異再修正");
    const rows = await reconciliationPreview(env, groupBuyId);
    const changed = rows.filter(row => row.stockEnabled && row.difference !== 0);
    const statements = [];
    for (const row of changed) {
        const remaining = row.sellableQuantity - row.actualSoldQuantity;
        if (remaining < 0) {
            throw new InventoryHttpError(409, "NEGATIVE_RECONCILIATION", `${row.productCode} 的有效訂單已超過可賣數量，請先調整庫存`);
        }
        const status = stockStatus(remaining, row.lowStockThreshold, true);
        statements.push(
            env.DB.prepare(`UPDATE group_buy_products SET sold_quantity = ?, remaining_quantity = ?,
                stock_status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE group_buy_id = ? AND product_id = ?`)
                .bind(row.actualSoldQuantity, remaining, status, groupBuyId, row.productId),
            env.DB.prepare(`INSERT INTO inventory_movements
                (id, group_buy_id, product_id, movement_type, quantity_change,
                 quantity_before, quantity_after, source_type, notes)
                VALUES (?, ?, ?, 'admin_adjustment', ?, ?, ?, 'reconciliation', ?)`)
                .bind(crypto.randomUUID(), groupBuyId, row.productId,
                    remaining - row.remainingQuantity, row.remainingQuantity, remaining,
                    String(payload.reason || "重新核對庫存").trim().slice(0, 500))
        );
    }
    if (statements.length) await env.DB.batch(statements);
    return { corrected: changed.length, stocks: await listStock(env, groupBuyId) };
}

module.exports = {
    InventoryHttpError,
    stockStatus,
    publicStock,
    getStock,
    listStock,
    configureStock,
    adjustStock,
    prepareOrderMutation,
    executePreparedMutations,
    executeOrderMutation,
    reconciliationPreview,
    applyReconciliation
};
