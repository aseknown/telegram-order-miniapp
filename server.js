require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const { products, currency } = require('./config');

const required = ['BOT_TOKEN', 'ADMIN_TELEGRAM_ID', 'PUBLIC_URL', 'DATABASE_URL'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID);
const PUBLIC_URL = process.env.PUBLIC_URL.replace(/\/$/, '');
const PORT = Number(process.env.PORT || 3000);
const INIT_DATA_MAX_AGE_SECONDS = Number(process.env.INIT_DATA_MAX_AGE_SECONDS || 86400);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.PGSSL || '').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : undefined
});

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, or WEBP images are allowed.'), ok);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function validateInitData(initData) {
  if (!initData) return { ok: false, reason: 'Missing Telegram initData' };

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) return { ok: false, reason: 'Missing hash' };
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(calculatedHash, 'hex');
  const b = Buffer.from(receivedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Invalid Telegram signature' };
  }

  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || Math.abs(now - authDate) > INIT_DATA_MAX_AGE_SECONDS) {
    return { ok: false, reason: 'Telegram authentication data is too old' };
  }

  let user;
  try {
    user = JSON.parse(params.get('user') || '{}');
  } catch {
    return { ok: false, reason: 'Invalid user data' };
  }
  if (!user.id) return { ok: false, reason: 'Telegram user is missing' };

  return { ok: true, user };
}

async function ensureDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL,
      telegram_username TEXT,
      customer_name TEXT,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 99),
      unit_price NUMERIC(12,2) NOT NULL,
      total NUMERIC(12,2) NOT NULL,
      payment_reference TEXT NOT NULL UNIQUE,
      screenshot_file_id TEXT,
      product_link TEXT,
      status TEXT NOT NULL DEFAULT 'WAITING_REVIEW',
      admin_message_chat_id BIGINT,
      admin_message_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS admin_states (
      admin_id BIGINT PRIMARY KEY,
      action TEXT NOT NULL,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function adminKeyboard(order) {
  const rows = [];
  if (!order.product_link) {
    rows.push([Markup.button.callback('🔗 Attach product link', `link:${order.id}`)]);
  } else {
    rows.push([Markup.button.callback('✅ Accept & Send', `accept:${order.id}`)]);
    rows.push([Markup.button.callback('🔗 Change product link', `link:${order.id}`)]);
  }
  rows.push([
    Markup.button.callback('❌ Reject', `reject:${order.id}`),
    Markup.button.callback('💬 Contact', `contact:${order.id}`)
  ]);
  return Markup.inlineKeyboard(rows);
}

function orderCaption(order) {
  const username = order.telegram_username ? `@${escapeHtml(order.telegram_username)}` : '(no username)';
  const linkLine = order.product_link
    ? `\n🔗 <b>Delivery link attached:</b> ${escapeHtml(order.product_link)}`
    : '\n🔗 <b>Delivery link:</b> not attached yet';

  return [
    `🛒 <b>ORDER #${order.id}</b>`,
    '',
    `👤 ${escapeHtml(order.customer_name || 'Customer')} — ${username}`,
    `🆔 Telegram ID: <code>${order.telegram_user_id}</code>`,
    `📦 ${escapeHtml(order.product_name)} × ${order.quantity}`,
    `💰 Total: <b>${escapeHtml(order.total)} ${escapeHtml(currency)}</b>`,
    `🧾 Ref: <code>${escapeHtml(order.payment_reference)}</code>`,
    `📌 Status: <b>${escapeHtml(order.status)}</b>`,
    linkLine,
    '',
    'Check the screenshot AND confirm the money arrived in your account before accepting.'
  ].join('\n');
}

async function getOrder(id) {
  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  return result.rows[0];
}

async function refreshAdminMessage(order) {
  if (!order.admin_message_chat_id || !order.admin_message_id) return;
  try {
    await bot.telegram.editMessageCaption(
      order.admin_message_chat_id,
      order.admin_message_id,
      undefined,
      orderCaption(order),
      { parse_mode: 'HTML', ...adminKeyboard(order) }
    );
  } catch (err) {
    console.error('Could not refresh admin message:', err.description || err.message);
  }
}

app.get('/api/config', (_req, res) => {
  res.json({
    currency,
    products,
    payment: {
      title: process.env.PAYMENT_TITLE || 'Manual transfer',
      cardHolder: process.env.CARD_HOLDER || '',
      cardNumber: process.env.CARD_NUMBER || '',
      note: process.env.PAYMENT_NOTE || 'Pay manually and upload your payment screenshot.'
    }
  });
});

app.post('/api/orders', upload.single('screenshot'), async (req, res) => {
  try {
    const verified = validateInitData(req.body.initData);
    if (!verified.ok) return res.status(401).json({ error: verified.reason });
    if (!req.file) return res.status(400).json({ error: 'Payment screenshot is required.' });

    const product = products.find(p => p.id === req.body.productId);
    if (!product) return res.status(400).json({ error: 'Unknown product.' });

    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 99.' });
    }

    const user = verified.user;
    const total = Number(product.price) * quantity;
    const customerName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Customer';
    const reference = `ORD-${Date.now().toString(36).toUpperCase()}-${String(user.id).slice(-4)}`;

    const inserted = await pool.query(
      `INSERT INTO orders
       (telegram_user_id, telegram_username, customer_name, product_id, product_name, quantity, unit_price, total, payment_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [user.id, user.username || null, customerName, product.id, product.name, quantity, product.price, total, reference]
    );
    let order = inserted.rows[0];

    const sent = await bot.telegram.sendPhoto(
      ADMIN_ID,
      { source: req.file.buffer, filename: req.file.originalname || 'payment.jpg' },
      {
        caption: orderCaption(order),
        parse_mode: 'HTML',
        ...adminKeyboard(order)
      }
    );

    const fileId = sent.photo?.[sent.photo.length - 1]?.file_id || null;
    const updated = await pool.query(
      `UPDATE orders SET screenshot_file_id=$1, admin_message_chat_id=$2, admin_message_id=$3 WHERE id=$4 RETURNING *`,
      [fileId, sent.chat.id, sent.message_id, order.id]
    );
    order = updated.rows[0];

    await bot.telegram.sendMessage(
      user.id,
      `✅ Order #${order.id} received.\n\nProduct: ${order.product_name} × ${order.quantity}\nTotal: ${order.total} ${currency}\nReference: ${order.payment_reference}\n\nStatus: ⏳ Waiting for manual payment review. You will receive your product link here after support approves it.`
    );

    res.json({ ok: true, orderId: order.id, reference: order.payment_reference });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create order. Please try again.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

bot.start(async ctx => {
  if (String(ctx.from.id) === ADMIN_ID) {
    await ctx.reply(
      `Admin mode ready. Your Telegram ID is ${ctx.from.id}.\n\nCustomers can use the shop button below.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🛍 Open Shop', PUBLIC_URL)]])
    );
    return;
  }

  await ctx.reply(
    'Welcome! Open the shop, choose your product, make the manual transfer, and upload your payment screenshot.',
    Markup.inlineKeyboard([[Markup.button.webApp('🛍 Open Shop', PUBLIC_URL)]])
  );
});

bot.command('shop', async ctx => {
  await ctx.reply('Open the shop:', Markup.inlineKeyboard([[Markup.button.webApp('🛍 Open Shop', PUBLIC_URL)]]));
});

bot.command('id', async ctx => {
  await ctx.reply(`Your Telegram ID: ${ctx.from.id}`);
});

bot.action(/^link:(\d+)$/, async ctx => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin only');
  const orderId = Number(ctx.match[1]);
  const order = await getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Order not found');
  if (['ACCEPTED', 'REJECTED'].includes(order.status)) return ctx.answerCbQuery('Order already closed');

  await pool.query(
    `INSERT INTO admin_states(admin_id, action, order_id) VALUES($1,'AWAIT_LINK',$2)
     ON CONFLICT(admin_id) DO UPDATE SET action='AWAIT_LINK', order_id=EXCLUDED.order_id, created_at=NOW()`,
    [ADMIN_ID, orderId]
  );
  await ctx.answerCbQuery();
  await ctx.reply(`🔗 Send the delivery/product link for order #${orderId} as your next message.\n\nSend /cancel to stop.`);
});

bot.command('cancel', async ctx => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  await pool.query('DELETE FROM admin_states WHERE admin_id=$1', [ADMIN_ID]);
  await ctx.reply('Cancelled.');
});

bot.on('text', async ctx => {
  if (String(ctx.from.id) !== ADMIN_ID) return;
  if (ctx.message.text.startsWith('/')) return;

  const stateResult = await pool.query('SELECT * FROM admin_states WHERE admin_id=$1', [ADMIN_ID]);
  const state = stateResult.rows[0];
  if (!state || state.action !== 'AWAIT_LINK') return;

  const link = ctx.message.text.trim();
  let parsed;
  try {
    parsed = new URL(link);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    await ctx.reply('That does not look like a valid http/https link. Please send the product link again, or /cancel.');
    return;
  }

  const result = await pool.query(
    `UPDATE orders SET product_link=$1, status='READY_TO_SEND' WHERE id=$2 AND status NOT IN ('ACCEPTED','REJECTED') RETURNING *`,
    [link, state.order_id]
  );
  await pool.query('DELETE FROM admin_states WHERE admin_id=$1', [ADMIN_ID]);

  const order = result.rows[0];
  if (!order) return ctx.reply('Order was already closed or no longer exists.');
  await refreshAdminMessage(order);
  await ctx.reply(`✅ Link attached to order #${order.id}. Now use “Accept & Send” on the order message after you confirm the payment.`);
});

bot.action(/^accept:(\d+)$/, async ctx => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin only');
  const orderId = Number(ctx.match[1]);
  let order = await getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Order not found');
  if (order.status === 'ACCEPTED') return ctx.answerCbQuery('Already accepted');
  if (order.status === 'REJECTED') return ctx.answerCbQuery('Already rejected');
  if (!order.product_link) return ctx.answerCbQuery('Attach a product link first', { show_alert: true });

  // Send first. Only mark ACCEPTED after Telegram confirms delivery.
  await bot.telegram.sendMessage(
    order.telegram_user_id,
    `✅ Payment approved — order #${order.id}\n\n📦 ${order.product_name} × ${order.quantity}\n\n🔗 Your product link:\n${order.product_link}\n\nIf you have any problem, reply to this bot and contact support.`
  );

  const result = await pool.query(
    `UPDATE orders SET status='ACCEPTED', reviewed_at=NOW() WHERE id=$1 RETURNING *`,
    [orderId]
  );
  order = result.rows[0];
  await refreshAdminMessage(order);
  await ctx.answerCbQuery('Accepted and product link sent ✅');
});

bot.action(/^reject:(\d+)$/, async ctx => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin only');
  const orderId = Number(ctx.match[1]);
  let order = await getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Order not found');
  if (order.status === 'ACCEPTED') return ctx.answerCbQuery('Already accepted');
  if (order.status === 'REJECTED') return ctx.answerCbQuery('Already rejected');

  await bot.telegram.sendMessage(
    order.telegram_user_id,
    `❌ Order #${order.id} was not approved.\n\nWe could not verify the payment. Please reply here to contact support before sending another payment.`
  );
  const result = await pool.query(
    `UPDATE orders SET status='REJECTED', reviewed_at=NOW() WHERE id=$1 RETURNING *`,
    [orderId]
  );
  order = result.rows[0];
  await refreshAdminMessage(order);
  await ctx.answerCbQuery('Order rejected');
});

bot.action(/^contact:(\d+)$/, async ctx => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('Admin only');
  const order = await getOrder(Number(ctx.match[1]));
  if (!order) return ctx.answerCbQuery('Order not found');

  if (order.telegram_username) {
    await ctx.reply(`💬 Customer for order #${order.id}: https://t.me/${order.telegram_username}`);
  } else {
    await ctx.reply(`💬 Customer has no public username. Telegram ID: ${order.telegram_user_id}. You can communicate through bot messages.`);
  }
  await ctx.answerCbQuery();
});

bot.catch(err => console.error('Bot error:', err));

(async () => {
  await ensureDb();
  app.listen(PORT, () => console.log(`Web server listening on ${PORT}`));
  await bot.launch();
  console.log('Telegram bot started with long polling.');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
