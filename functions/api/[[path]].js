import { marketplace, verifyContact } from '../../lib/marketplace.js';

const enc = new TextEncoder();

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  try {
    const response = await marketplace(context, validateTelegramInitData);
    if (response) return response;
    if (path === "/api/config" && context.request.method === "GET") {
      return json({
        products: getProducts(context.env),
        currency: context.env.CURRENCY || "USD",
        payment: {
          label: context.env.PAYMENT_LABEL || "Payment number",
          number: context.env.PAYMENT_NUMBER || "",
          holder: context.env.PAYMENT_HOLDER || "",
          note: context.env.PAYMENT_NOTE || ""
        },
        botUsername: context.env.BOT_USERNAME || ""
      });
    }
    if (path === "/api/order" && context.request.method === "POST") return await submitOrder(context);
    if (path === "/api/telegram" && context.request.method === "POST") return await telegramWebhook(context);
    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error('api_request_failed', { path, name: err.name });
    return json({ error: "Server error" }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function getProducts(env) {
  let products;
  try { products = JSON.parse(env.PRODUCTS_JSON || "[]"); }
  catch { throw new Error("PRODUCTS_JSON is invalid JSON"); }
  if (!Array.isArray(products) || products.length === 0) throw new Error("No products configured");
  return products;
}

async function submitOrder(context) {
  const env = context.env;
  if (env.LEGACY_CHECKOUT_ENABLED !== 'true') return json({ error: 'Use a marketplace shop link to submit orders.' },410);
  if (!env.BOT_TOKEN) return json({ error: "Checkout is unavailable. Configure BOT_TOKEN in this Cloudflare deployment's secrets, then redeploy." }, 503);
  if (!env.ADMIN_TELEGRAM_ID) return json({ error: "Checkout is unavailable. Configure ADMIN_TELEGRAM_ID for the legacy shop, then redeploy." }, 503);

  const form = await context.request.formData();
  const initData = String(form.get("initData") || "");
  const productId = String(form.get("productId") || "");
  const quantity = Math.max(1, Math.min(20, parseInt(String(form.get("quantity") || "1"), 10) || 1));
  const receipt = form.get("receipt");

  const auth = await validateTelegramInitData(initData, env.BOT_TOKEN);
  if (!auth.ok) return json({ error: auth.error }, 401);

  if (!(receipt instanceof File)) return json({ error: "Receipt image is required." }, 400);
  if (!["image/jpeg","image/png","image/webp"].includes(receipt.type)) return json({ error: "Receipt must be JPG, PNG or WebP." }, 400);
  if (receipt.size > 10 * 1024 * 1024) return json({ error: "Receipt is larger than 10 MB." }, 400);

  const product = getProducts(env).find(p => String(p.id) === productId);
  if (!product) return json({ error: "Unknown product." }, 400);

  const user = auth.user;
  if (!user?.id) return json({ error: "Telegram user is missing." }, 401);

  const unitPrice = Number(product.price);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return json({ error: "Product price is invalid." }, 500);
  const total = unitPrice * quantity;
  const customerName = [user.first_name, user.last_name].filter(Boolean).join(" ");

  const result = await env.DB.prepare(`
    INSERT INTO orders
    (telegram_user_id, telegram_username, customer_name, product_id, product_name,
     quantity, unit_price, total, status, admin_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAITING_REVIEW', ?)
  `).bind(
    String(user.id), user.username || null, customerName || null, String(product.id),
    String(product.name), quantity, unitPrice, total, String(env.ADMIN_TELEGRAM_ID)
  ).run();

  const orderId = result.meta.last_row_id;
  const order = {
    id: orderId, telegram_user_id: String(user.id), telegram_username: user.username || null,
    customer_name: customerName || null, product_name: product.name, quantity, total,
    status: "WAITING_REVIEW", delivery_link: null
  };

  const body = new FormData();
  body.append("chat_id", String(env.ADMIN_TELEGRAM_ID));
  body.append("photo", receipt, receipt.name || "receipt.jpg");
  body.append("caption", buildAdminCaption(order, env));
  body.append("parse_mode", "HTML");
  body.append("reply_markup", JSON.stringify(adminKeyboard(orderId, "WAITING_REVIEW", null, user.username)));

  const tgResult = await telegramMultipart(env.BOT_TOKEN, "sendPhoto", body);
  const adminMessageId = tgResult?.result?.message_id;
  if (adminMessageId) {
    await env.DB.prepare("UPDATE orders SET admin_message_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(adminMessageId, orderId).run();
  }

  await telegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: String(user.id),
    text: `🧾 Order #${orderId} received.\n\n${product.name} × ${quantity}\nTotal: ${formatMoney(total, env)}\n\nStatus: waiting for manual payment review.`
  }).catch(console.error);

  return json({ ok: true, orderId });
}

async function telegramWebhook(context) {
  const env = context.env;
  const secret = context.request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Unauthorized webhook" }, 401);

  const update = await context.request.json();
  if (update.callback_query) await handleCallback(update.callback_query, env);
  else if (update.message) await handleMessage(update.message, env);
  return json({ ok: true });
}

async function handleMessage(message, env) {
  const fromId = String(message.from?.id || "");
  const adminId = String(env.ADMIN_TELEGRAM_ID || "");
  const text = String(message.text || "").trim();
  if (!fromId) return;

  const contactReply = await verifyContact(message, env);
  if (contactReply) {
    await telegram(env.BOT_TOKEN, 'sendMessage', { chat_id: fromId, text: contactReply });
    return;
  }
  if (message.chat?.type === 'private' && (text.startsWith('/start') || text === '/phone')) {
    const slug = text.split(/\s+/)[1];
    const shopPath = slug && /^[a-z0-9][a-z0-9_-]{2,39}$/.test(slug) ? '/' + slug : '/';
    await telegram(env.BOT_TOKEN, 'sendMessage', {
      chat_id: fromId,
      text: 'Share your phone to use one account across all shops. Then open the marketplace.',
      reply_markup: { keyboard: [[{ text: 'Share my phone', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    });
    await telegram(env.BOT_TOKEN, 'sendMessage', {
      chat_id: fromId, text: 'Open your shop or manage your store:',
      reply_markup: { inline_keyboard: [[{ text: 'Open marketplace', web_app: {url: new URL(shopPath,env.PUBLIC_URL).href} }]] }
    });
    return;
  }

  if (env.LEGACY_CHECKOUT_ENABLED !== 'true') {
    if(message.chat?.type === 'private') await telegram(env.BOT_TOKEN,'sendMessage',{chat_id:fromId,text:'Open the marketplace to view your orders or manage your store. Use /phone to verify your account.'});
    return;
  }

  if (fromId === adminId) {
    const pending = await env.DB.prepare("SELECT * FROM admin_pending WHERE admin_id=?").bind(adminId).first();

    if (pending?.action === "ATTACH_LINK") {
      if (!/^https?:\/\/\S+$/i.test(text)) {
        await telegram(env.BOT_TOKEN, "sendMessage", { chat_id: adminId, text: "⚠️ Send one full http:// or https:// delivery link." });
        return;
      }
      const order = await getOrder(env, pending.order_id);
      if (!order) return;
      await env.DB.batch([
        env.DB.prepare("UPDATE orders SET delivery_link=?, status='READY_TO_SEND', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(text, order.id),
        env.DB.prepare("DELETE FROM admin_pending WHERE admin_id=?").bind(adminId)
      ]);
      await refreshAdminMessage({ ...order, delivery_link: text, status: "READY_TO_SEND" }, env);
      await telegram(env.BOT_TOKEN, "sendMessage", { chat_id: adminId, text: `✅ Link attached to order #${order.id}. You can now tap “Accept & Send”.` });
      return;
    }

    if (pending?.action === "MESSAGE_CUSTOMER") {
      if (!text) return;
      const order = await getOrder(env, pending.order_id);
      if (!order) return;
      await telegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: String(order.telegram_user_id),
        text: `💬 Support — order #${order.id}\n\n${text}`
      });
      await env.DB.prepare("DELETE FROM admin_pending WHERE admin_id=?").bind(adminId).run();
      await telegram(env.BOT_TOKEN, "sendMessage", { chat_id: adminId, text: `✅ Message sent to customer for order #${order.id}.` });
      return;
    }

    if (text === "/start") {
      await telegram(env.BOT_TOKEN, "sendMessage", { chat_id: adminId, text: "Admin mode is ready. New orders will appear here." });
    }
    return;
  }

  if (text.startsWith("/start")) {
    await telegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: fromId,
      text: "Welcome. Open the shop below to place an order.",
      reply_markup: { inline_keyboard: [[{ text: "🛍 Open Shop", web_app: { url: env.PUBLIC_URL } }]] }
    });
    return;
  }

  const who = message.from?.username
    ? `@${message.from.username}`
    : [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || fromId;

  await telegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: adminId,
    text: `💬 Customer support message\nFrom: ${who}\nTelegram ID: ${fromId}\n\n${text || "[non-text message]"}`
  });
  await telegram(env.BOT_TOKEN, "sendMessage", { chat_id: fromId, text: "✅ Your message was sent to support." });
}

async function handleCallback(cb, env) {
  const adminId = String(env.ADMIN_TELEGRAM_ID || "");
  if (String(cb.from?.id || "") !== adminId) return answerCallback(env, cb.id, "Admin only.");

  const [action, rawId] = String(cb.data || "").split(":");
  const orderId = Number(rawId);
  if (!orderId) return answerCallback(env, cb.id, "Invalid order.");

  const order = await getOrder(env, orderId);
  if (!order) return answerCallback(env, cb.id, "Order not found.");

  if (action === "attach") {
    await env.DB.prepare(`
      INSERT INTO admin_pending (admin_id, order_id, action, created_at)
      VALUES (?, ?, 'ATTACH_LINK', CURRENT_TIMESTAMP)
      ON CONFLICT(admin_id) DO UPDATE SET order_id=excluded.order_id, action='ATTACH_LINK', created_at=CURRENT_TIMESTAMP
    `).bind(adminId, orderId).run();
    await answerCallback(env, cb.id, "Send the product link in this chat.");
    await telegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: adminId, text: `🔗 Send the delivery link for order #${orderId} as your next message.\nExample:\nhttps://example.com/private-link`
    });
    return;
  }

  if (action === "message") {
    await env.DB.prepare(`
      INSERT INTO admin_pending (admin_id, order_id, action, created_at)
      VALUES (?, ?, 'MESSAGE_CUSTOMER', CURRENT_TIMESTAMP)
      ON CONFLICT(admin_id) DO UPDATE SET order_id=excluded.order_id, action='MESSAGE_CUSTOMER', created_at=CURRENT_TIMESTAMP
    `).bind(adminId, orderId).run();
    await answerCallback(env, cb.id, "Send your message next.");
    await telegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: adminId, text: `💬 Send your message for customer of order #${orderId} as your next message.`
    });
    return;
  }

  if (action === "accept") {
    if (!order.delivery_link || order.status !== "READY_TO_SEND") return answerCallback(env, cb.id, "Attach a product link first.", true);

    await telegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: String(order.telegram_user_id),
      text: `✅ Payment approved — order #${order.id}\n\n${order.product_name} × ${order.quantity}\n\n🔗 Your product link:\n${order.delivery_link}\n\nIf you need help, reply to this bot.`
    });
    await env.DB.prepare("UPDATE orders SET status='ACCEPTED', accepted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(order.id).run();
    await answerCallback(env, cb.id, "Accepted and sent.");
    await refreshAdminMessage({ ...order, status: "ACCEPTED" }, env);
    return;
  }

  if (action === "reject") {
    if (order.status === "ACCEPTED") return answerCallback(env, cb.id, "Accepted orders cannot be rejected.", true);
    await env.DB.prepare("UPDATE orders SET status='REJECTED', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(order.id).run();
    await telegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: String(order.telegram_user_id),
      text: `❌ Order #${order.id} was not approved.\n\nPlease reply to this bot if you need support or need to send another payment receipt.`
    });
    await answerCallback(env, cb.id, "Order rejected.");
    await refreshAdminMessage({ ...order, status: "REJECTED" }, env);
    return;
  }

  await answerCallback(env, cb.id, "Unknown action.");
}

async function refreshAdminMessage(order, env) {
  if (!order.admin_message_id) return;
  await telegram(env.BOT_TOKEN, "editMessageCaption", {
    chat_id: String(order.admin_chat_id || env.ADMIN_TELEGRAM_ID),
    message_id: Number(order.admin_message_id),
    caption: buildAdminCaption(order, env),
    parse_mode: "HTML",
    reply_markup: adminKeyboard(order.id, order.status, order.delivery_link, order.telegram_username)
  }).catch(console.error);
}

function adminKeyboard(orderId, status, deliveryLink, username) {
  const rows = [];
  if (status === "WAITING_REVIEW") rows.push([{ text: "🔗 Attach product link", callback_data: `attach:${orderId}` }]);
  if (status === "READY_TO_SEND" && deliveryLink) {
    rows.push([{ text: "✅ Accept & Send", callback_data: `accept:${orderId}` }]);
    rows.push([{ text: "🔗 Change product link", callback_data: `attach:${orderId}` }]);
  }
  if (!["ACCEPTED", "REJECTED"].includes(status)) {
    rows.push([
      { text: "❌ Reject", callback_data: `reject:${orderId}` },
      { text: "💬 Message customer", callback_data: `message:${orderId}` }
    ]);
  }
  if (username) rows.push([{ text: "↗ Open customer chat", url: `https://t.me/${username}` }]);
  return { inline_keyboard: rows };
}

function buildAdminCaption(order, env) {
  const userDisplay = order.telegram_username ? `@${escapeHtml(order.telegram_username)}` : escapeHtml(order.customer_name || order.telegram_user_id);
  const statusIcon = { WAITING_REVIEW: "⏳", READY_TO_SEND: "🔗", ACCEPTED: "✅", REJECTED: "❌" }[order.status] || "•";
  return [
    `<b>🛒 ORDER #${order.id}</b>`, "",
    `<b>Customer:</b> ${userDisplay}`,
    `<b>Telegram ID:</b> <code>${escapeHtml(order.telegram_user_id)}</code>`,
    `<b>Product:</b> ${escapeHtml(order.product_name)} × ${order.quantity}`,
    `<b>Total:</b> ${escapeHtml(formatMoney(order.total, env))}`, "",
    `<b>Status:</b> ${statusIcon} ${escapeHtml(order.status)}`,
    `<b>Delivery link:</b> ${order.delivery_link ? "attached" : "not attached"}`, "",
    "Verify the payment in your bank account yourself. The screenshot alone is not proof of payment."
  ].join("\n");
}

async function getOrder(env, id) { return env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first(); }
function formatMoney(amount, env) { return `${Number(amount).toFixed(2)} ${env.CURRENCY || "USD"}`; }
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
async function answerCallback(env, id, text, show_alert = false) {
  return telegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: id, text, show_alert }).catch(console.error);
}

async function telegram(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed (${res.status})`);
  return data;
}

async function telegramMultipart(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body, signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed (${res.status})`);
  return data;
}

export async function validateTelegramInitData(initData, botToken) {
  if (!initData) return { ok: false, error: "Telegram initData is missing." };
  const params = new URLSearchParams(initData);
  if ([...params.keys()].length !== new Set(params.keys()).size) return { ok:false, error:'Duplicate authentication fields.' };
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date") || 0);
  if (!receivedHash) return { ok: false, error: "Telegram hash is missing." };
  if (!Number.isInteger(authDate) || authDate > Date.now()/1000+60 || Date.now()/1000-authDate > 3600) return { ok: false, error: "Telegram session is too old. Reopen the shop." };

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const webAppKey = await crypto.subtle.importKey(
    "raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secretKeyBytes = await crypto.subtle.sign("HMAC", webAppKey, enc.encode(botToken));
  const secretKey = await crypto.subtle.importKey(
    "raw", secretKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const hashBytes = new Uint8Array(await crypto.subtle.sign("HMAC", secretKey, enc.encode(dataCheckString)));
  const calculatedHash = [...hashBytes].map(b => b.toString(16).padStart(2, "0")).join("");
  if (!timingSafeEqualHex(calculatedHash, receivedHash)) return { ok: false, error: "Telegram authentication failed." };

  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  return { ok: true, user };
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
