const LineOrder = require("../../line-order.js");

async function verifySignature(rawBody, signature, secret) {
    if (!signature || !secret) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const expected = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    if (expected.length !== signature.length) return false;
    let mismatch = 0;
    for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
    return mismatch === 0;
}

async function processUnsendEvent(event, dependencies) {
    const messageId = event.unsend?.messageId;
    if (!messageId || !dependencies.markUnsent) return;
    await dependencies.markUnsent(messageId, new Date(event.timestamp).toISOString());
}

async function processTextEvent(event, dependencies) {
    if (event.type !== "message" || event.message?.type !== "text") return;
    const conversationType = event.source?.type;
    if (conversationType !== "group" && conversationType !== "room") return;
    const messageId = event.message.id;
    if (await dependencies.hasMessage(messageId, event.webhookEventId || "")) return;

    const groupId = event.source.groupId || event.source.roomId;
    const lineUserId = event.source.userId || "";
    if (dependencies.rememberLineGroup) await dependencies.rememberLineGroup(conversationType, groupId);
    const displayName = await dependencies.getDisplayName(conversationType, groupId, lineUserId);
    const parsed = LineOrder.parseMessage(event.message.text, await dependencies.getProductCodes());
    const customer = lineUserId ? await dependencies.findCustomer(lineUserId, displayName) : null;
    let status = parsed.status;
    if (!customer && status === LineOrder.STATUS.READY) status = LineOrder.STATUS.CUSTOMER_UNMATCHED;

    const record = {
        messageId,
        webhookEventId: event.webhookEventId || "",
        groupId,
        lineUserId,
        displayName,
        customerId: customer?.id || "",
        customerNickname: customer?.nickname || "",
        rawMessage: event.message.text,
        normalizedMessage: parsed.normalized,
        parsedItems: parsed.items,
        action: parsed.action,
        targetProductPrefix: parsed.targetProductPrefix,
        pickupType: customer?.pickupType || "",
        messageTime: new Date(event.timestamp).toISOString(),
        status,
        errorReason: parsed.errorReason
    };
    if (await dependencies.isSuspectedDuplicate(record)) record.status = LineOrder.STATUS.DUPLICATE;
    await dependencies.insertInbox(record);
    console.log("LINE inbox stored", { sourceType: conversationType, action: record.action, status: record.status, itemCount: record.parsedItems.length });
}

async function processPostbackEvent(event, dependencies) {
    if (event.type !== "postback") return;
    const conversationType = event.source?.type;
    if (conversationType !== "group" && conversationType !== "room") return;
    const groupId = event.source.groupId || event.source.roomId || "";
    const lineUserId = event.source.userId || "";
    if (dependencies.rememberLineGroup) await dependencies.rememberLineGroup(conversationType, groupId);
    const displayName = await dependencies.getDisplayName(conversationType, groupId, lineUserId);
    await dependencies.processPostback({
        webhookEventId: event.webhookEventId || "",
        timestamp: event.timestamp,
        groupId,
        lineUserId,
        displayName,
        data: event.postback?.data || ""
    });
}

async function processEvent(event, dependencies) {
    if (event.type === "unsend") return processUnsendEvent(event, dependencies);
    if (event.type === "postback") return processPostbackEvent(event, dependencies);
    return processTextEvent(event, dependencies);
}

async function handleWebhook(request, env, context, dependencies) {
    const rawBody = await request.text();
    const valid = await verifySignature(rawBody, request.headers.get("x-line-signature"), env.LINE_CHANNEL_SECRET);
    if (!valid) return new Response("Invalid signature", { status: 401 });
    let payload;
    try { payload = JSON.parse(rawBody); } catch (_error) { return new Response("Invalid JSON", { status: 400 }); }
    const work = Promise.all((payload.events || []).map(async event => {
        try { await processEvent(event, dependencies); }
        catch (error) { console.error("LINE background processing failed", error); throw error; }
    }));
    context.waitUntil(work);
    return new Response("OK", { status: 200 });
}

module.exports = { verifySignature, processTextEvent, processPostbackEvent, processUnsendEvent, processEvent, handleWebhook };
