import { deliverNotifications } from './notifications.js';
import { management, isSuperAdmin, shopUsage } from './management.js';
import { issueSession } from './sessions.js';
import { listCatalog } from './catalog.js';

const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const id = () => crypto.randomUUID();
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
  }});
}
function required(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new ApiError(400, `${label} is required (maximum ${max} characters).`);
  return value.trim();
}
function optional(value, label, max = 1000) {
  if (value === undefined || value === '') return '';
  return required(value, label, max);
}
export function slugValue(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(value) || ['api','admin','merchant','assets','shop','www','pricing','support','stores','security'].includes(value)) {
    throw new ApiError(400, 'Shop username must be 3–40 lowercase letters, numbers, hyphens or underscores; this name may be reserved.');
  }
  return value;
}
export function priceMinor(value) {
  const text = String(value ?? '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new ApiError(400, 'Price must have at most two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function phoneValue(value) {
  const phone = '+' + String(value || '').replace(/^\+/, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new ApiError(400, 'A valid international phone number is required.');
  return phone;
}
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
}
async function bodyJson(request) {
  const bytes = await limitedBody(request, 65536);
  try {
    const body=JSON.parse(new TextDecoder().decode(bytes));
    if(!body || typeof body!=='object' || Array.isArray(body)) throw new Error('Expected object');
    return body;
  }
  catch { throw new ApiError(400, 'Invalid JSON.'); }
}
async function limitedBody(request, max) {
  if (Number(request.headers.get('content-length')) > max) throw new ApiError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'Request body is required.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new ApiError(413, 'Request is too large.'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function customer(context, validate, verified = true) {
  if (!context.env.BOT_TOKEN) throw new ApiError(503, 'Checkout is unavailable. The platform operator must configure BOT_TOKEN.');
  const header = context.request.headers.get('authorization') || '';
  if(header.length>16384) throw new ApiError(401,'Invalid authentication.');
  if(!/^Bearer [a-f0-9]{64}$/.test(header)) throw new ApiError(401,'Sign in through Telegram to continue.');
  const user=await context.env.DB.prepare(`SELECT c.*,a.id AS session_id FROM auth_sessions a JOIN customers c ON c.id=a.customer_id
    WHERE a.token_hash=? AND a.revoked_at IS NULL AND a.expires_at>?`).bind(await digest(header.slice(7)),now()).first();
  if(!user) throw new ApiError(401,'Your session has ended. Reopen the app from Telegram.');
  return {user,telegram:{first_name:user.name}};
}
async function ownedShop(env, shopId, user) {
  const shop = await env.DB.prepare('SELECT * FROM shops WHERE id=? AND owner_id=?').bind(shopId, user.id).first();
  if (!shop) throw new ApiError(404, 'Shop not found.');
  return shop;
}
function shopFields(body) {
  const currency = required(body.currency, 'Currency', 3).toUpperCase();
  // Fixed two-decimal currencies; add other exponents deliberately before accepting them.
  if (!['USD','EUR','GBP','AED','TRY','IRR'].includes(currency)) throw new ApiError(400, 'Unsupported currency.');
  const number = required(body.payment_number, 'Payment number', 34).replace(/[ -]/g, '');
  if (!/^[A-Z0-9]{8,34}$/.test(number)) throw new ApiError(400, 'Use a card, account or IBAN number.');
  return [required(body.name,'Shop name',80), optional(body.description,'Description',1000), currency,
    number, required(body.payment_holder,'Payment holder',100), optional(body.payment_note,'Payment note',500)];
}
function productFields(body) {
  if(body.active!==undefined && typeof body.active!=='boolean') throw new ApiError(400,'Availability must be true or false.');
  return [required(body.name,'Product name',120), optional(body.description,'Product description',1000), priceMinor(body.price), body.active === false ? 0 : 1];
}
const publicShopColumns = 'id,slug,name,description,currency,payment_number,payment_holder,payment_note';
function pageOffset(url) { const page = Number(url.searchParams.get('page') || 1); if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new ApiError(400,'Invalid page.'); return (page-1)*50; }
async function rateLimit(env,key,maximum) {
  const minute=Math.floor(now()/60);
  const row=await env.DB.prepare('INSERT INTO rate_limits (bucket,hits,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 RETURNING hits').bind(`${key}:${minute}`,(minute+2)*60).first();
  if(row.hits>maximum) throw new ApiError(429,'Too many requests. Try again in a minute.');
}

export async function marketplace(context, validate) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/v1/')) return null;
  try {
    if (!env.DB) throw new ApiError(503, 'Database is not configured.');
    if(path==='/api/v1/health' && request.method==='GET') {
      const schema=await env.DB.prepare('SELECT EXISTS(SELECT 1 FROM auth_sessions) AS sessions,EXISTS(SELECT 1 FROM platform_admins) AS admins,EXISTS(SELECT 1 FROM products WHERE is_public=1) AS products').first();
      const ready=Boolean(env.BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && schema.admins>0 && env.PUBLIC_URL && new URL(env.PUBLIC_URL).origin===url.origin);
      return json({ready,version:'marketplace-4'},ready?200:503);
    }
    if(path==='/api/v1/auth/session' && request.method==='POST') return await issueSession(context,validate,{digest,json,ApiError});
    if(path==='/api/v1/catalog' && request.method==='GET') return await listCatalog(env,url,null,{ApiError,json,optional,priceMinor,pageOffset});
    if (path === '/api/v1/config' && request.method === 'GET') return json({ botUsername: env.BOT_USERNAME || '', authentication: 'telegram-contact', checkoutAvailable: Boolean(env.BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET), maxAttachmentBytes: 1048576 });
    if (path === '/api/v1/plans' && request.method === 'GET') return json({plans:(await env.DB.prepare('SELECT id,name,product_limit,monthly_price_minor,currency FROM plans WHERE published=1 ORDER BY product_limit').all()).results,billing:'manual-request'});
    if (path === '/api/v1/shops' && request.method === 'GET') {
      const { results } = await env.DB.prepare("SELECT id,slug,name,description,currency FROM shops WHERE status='APPROVED' ORDER BY slug LIMIT 50 OFFSET ?").bind(pageOffset(url)).all();
      return json({ shops: results });
    }
    const publicMatch = path.match(/^\/api\/v1\/shops\/([a-z0-9_-]+)$/);
    if (publicMatch && request.method === 'GET') {
      const shop = await env.DB.prepare(`SELECT ${publicShopColumns} FROM shops WHERE slug=? AND status='APPROVED'`).bind(publicMatch[1]).first();
      if (!shop) throw new ApiError(404, 'Shop not found.');
      return await listCatalog(env,url,shop,{ApiError,json,optional,priceMinor,pageOffset});
    }
    if (path === '/api/v1/integrations/woocommerce' && request.method === 'POST') return await importProduct(context);
    const { user, telegram } = await customer(context, validate, path !== '/api/v1/me');
    if (user && !['GET','HEAD'].includes(request.method)) await rateLimit(env,'customer:'+user.id,30);
    if(path==='/api/v1/sessions' && request.method==='GET') return json({currentSessionId:user.session_id,sessions:(await env.DB.prepare('SELECT id,label,created_at,expires_at FROM auth_sessions WHERE customer_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 50').bind(user.id,now()).all()).results});
    if(path.startsWith('/api/v1/sessions/') && request.method==='DELETE') {
      const target=path.slice('/api/v1/sessions/'.length);
      const result=await env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE customer_id=? AND revoked_at IS NULL AND (id=? OR ?=\'all\')').bind(now(),user.id,target,target).run();
      return json({revoked:result.meta.changes});
    }
    if (path === '/api/v1/me' && request.method === 'GET') {
      const shops = user ? (await env.DB.prepare(`SELECT ${publicShopColumns},status,approval_note,revision,plan_id,plan_expires_at FROM shops WHERE owner_id=? ORDER BY created_at LIMIT 50`).bind(user.id).all()).results : [];
      return json({ customer: user ? { id:user.id, phone:user.phone, name:user.name } : null, telegramName:telegram.first_name, shops,isSuperAdmin:await isSuperAdmin(env,user) });
    }
    const managed=await management(context,user,{json,ApiError,bodyJson,required,optional,pageOffset,ownedShop});
    if(managed) return managed;
    if (path === '/api/v1/shops' && request.method === 'POST') {
      const body = await bodyJson(request); const shopId = id(); const slug = slugValue(body.slug);
      const fields = shopFields(body);
      // Prevent unbounded shop creation with one verified account.
      const { count } = await env.DB.prepare('SELECT count(*) AS count FROM shops WHERE owner_id=?').bind(user.id).first();
      if (count >= 10) throw new ApiError(409, 'Maximum 10 shops per account.');
      try {
        await env.DB.prepare('INSERT INTO shops (id,slug,owner_id,name,description,currency,payment_number,payment_holder,payment_note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(shopId,slug,user.id,...fields,now()).run();
      } catch (error) { if (String(error).includes('UNIQUE')) throw new ApiError(409,'Shop username is already taken.'); throw error; }
      return json({ id:shopId, slug,status:'PENDING',plan_id:'free' },201);
    }
    const merchant = path.match(/^\/api\/v1\/merchant\/([^/]+)(?:\/(products|orders|integration)(?:\/([^/]+))?)?$/);
    if (merchant) {
      const shop = await ownedShop(env,merchant[1],user);
      const section = merchant[2]; const resource = merchant[3];
      if (!section && request.method === 'PATCH') {
        const body = await bodyJson(request);
        // Existing order snapshots retain their original bank details and currency.
        const fields = shopFields(body);
        if (fields[2] !== shop.currency) throw new ApiError(400,'Shop currency cannot change after creation.');
        if(!Number.isSafeInteger(body.revision) || body.revision<0) throw new ApiError(400,'Refresh the shop before editing.');
        const result=await env.DB.prepare("UPDATE shops SET name=?,description=?,currency=?,payment_number=?,payment_holder=?,payment_note=?,status=CASE WHEN status IN ('APPROVED','REJECTED') THEN 'PENDING' ELSE status END,revision=revision+1 WHERE id=? AND owner_id=? AND revision=?").bind(...fields,shop.id,user.id,body.revision).run();
        if(!result.meta.changes) throw new ApiError(409,'Shop changed. Refresh before editing.');
        return json({ ok:true });
      }
      if(shop.status==='SUSPENDED' && ['products','integration'].includes(section) && !['GET','DELETE'].includes(request.method)) throw new ApiError(403,'Suspended shops cannot change their catalog or connection. Contact support.');
      if (section === 'products' && request.method === 'GET') return json({ products:(await env.DB.prepare('SELECT * FROM products WHERE shop_id=? ORDER BY id LIMIT 50 OFFSET ?').bind(shop.id,pageOffset(url)).all()).results });
      if (section === 'products' && request.method === 'POST' && !resource) {
        const productId = id(); const body=await bodyJson(request); const fields = productFields(body);
        const category=body.category_id ? required(body.category_id,'Category',80) : null;
        if(body.isPublic!==undefined && typeof body.isPublic!=='boolean') throw new ApiError(400,'Public visibility must be true or false.');
        await env.DB.prepare('INSERT INTO products (id,shop_id,name,description,price_minor,active,category_id,is_public) VALUES (?,?,?,?,?,?,?,?)').bind(productId,shop.id,...fields,category,body.isPublic===true?1:0).run();
        return json({id:productId},201);
      }
      if (section === 'products' && request.method === 'PATCH' && resource) {
        const body=await bodyJson(request); const category=body.category_id ? required(body.category_id,'Category',80) : null;
        if(body.isPublic!==undefined && typeof body.isPublic!=='boolean') throw new ApiError(400,'Public visibility must be true or false.');
        if(Object.keys(body).length>0 && Object.keys(body).every(key=>['category_id','isPublic'].includes(key))) {
          const result=await env.DB.prepare('UPDATE products SET category_id=CASE WHEN ? THEN ? ELSE category_id END,is_public=CASE WHEN ? THEN ? ELSE is_public END WHERE id=? AND shop_id=?').bind(Object.hasOwn(body,'category_id')?1:0,category,Object.hasOwn(body,'isPublic')?1:0,body.isPublic===true?1:0,resource,shop.id).run();
          if(!result.meta.changes) throw new ApiError(404,'Product not found.'); return json({ok:true});
        }
        const fields = productFields(body);
        const changed = await env.DB.prepare('UPDATE products SET name=?,description=?,price_minor=?,active=?,category_id=?,archived=0,is_public=CASE WHEN ? THEN ? ELSE is_public END WHERE id=? AND shop_id=? AND source_id IS NULL').bind(...fields,category,Object.hasOwn(body,'isPublic')?1:0,body.isPublic===true?1:0,resource,shop.id).run();
        if (!changed.meta.changes) throw new ApiError(404,'Manual product not found; edit imported products in WooCommerce.');
        return json({ok:true});
      }
      if(section==='products' && resource && request.method==='DELETE') {
        const result=await env.DB.prepare('UPDATE products SET archived=1,active=0 WHERE id=? AND shop_id=? AND source_id IS NULL').bind(resource,shop.id).run();
        if(!result.meta.changes) throw new ApiError(404,'Manual product not found; archive imports in WooCommerce.'); return json({ok:true});
      }
      if (section === 'integration' && request.method === 'POST') {
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
        await env.DB.prepare('INSERT INTO shop_integrations (shop_id,token_hash,created_at) VALUES (?,?,?) ON CONFLICT(shop_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at').bind(shop.id,await digest(token),now()).run();
        return json({ token, endpoint:url.origin+'/api/v1/integrations/woocommerce' });
      }
      if (section === 'integration' && request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM shop_integrations WHERE shop_id=?').bind(shop.id).run(); return json({ok:true});
      }
      if (section === 'orders' && request.method === 'GET') return json({orders:(await env.DB.prepare(`SELECT o.*,c.name AS customer_name,c.phone AS customer_phone,
        (SELECT count(*) FROM notifications n WHERE n.order_id=o.id AND n.state='FAILED') AS failed_notifications
        FROM marketplace_orders o JOIN customers c ON c.id=o.customer_id WHERE o.shop_id=? ORDER BY o.created_at DESC,o.id LIMIT 50 OFFSET ?`).bind(shop.id,pageOffset(url)).all()).results});
      if (section === 'orders' && resource && request.method === 'PATCH') return await reviewOrder(context, shop, user, resource, await bodyJson(request));
    }
    if (path === '/api/v1/orders' && request.method === 'POST') return await createOrder(context,user);
    if (path === '/api/v1/orders' && request.method === 'GET') return json({orders:(await env.DB.prepare('SELECT * FROM marketplace_orders WHERE customer_id=? ORDER BY created_at DESC,id LIMIT 50 OFFSET ?').bind(user.id,pageOffset(url)).all()).results});
    const orderMatch = path.match(/^\/api\/v1\/orders\/([^/]+)\/attachments(?:\/([^/]+))?$/);
    if (orderMatch && request.method === 'GET') {
      const order = await env.DB.prepare('SELECT o.id FROM marketplace_orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=? AND (o.customer_id=? OR s.owner_id=? OR EXISTS (SELECT 1 FROM platform_admins WHERE customer_id=?))').bind(orderMatch[1],user.id,user.id,user.id).first();
      if (!order) throw new ApiError(404,'Order not found.');
      if (!orderMatch[2]) return json({attachments:(await env.DB.prepare('SELECT id,mime FROM attachments WHERE order_id=?').bind(order.id).all()).results});
      const file = await env.DB.prepare('SELECT mime,content FROM attachments WHERE id=? AND order_id=?').bind(orderMatch[2],order.id).first();
      if (!file) throw new ApiError(404,'Attachment not found.');
      return new Response(new Uint8Array(file.content),{headers:{'content-type':file.mime,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':'attachment; filename="receipt"'}});
    }
    throw new ApiError(404,'Not found.');
  } catch (error) {
    if (error instanceof ApiError) return json({error:error.message},error.status);
    if(String(error).includes('PRODUCT_LIMIT')) return json({error:'Your plan product limit has been reached. Archive a product or request an upgrade.'},409);
    if(String(error).includes('CATEGORY_SCOPE')) return json({error:'Category does not belong to this shop.'},400);
    if(String(error).includes('SHOP_UNAVAILABLE')) return json({error:'This shop or product is no longer available for orders.'},409);
    if(String(error).includes('UNIQUE constraint failed: categories')) return json({error:'Category name is already in use.'},409);
    if(String(error).includes('LAST_ADMIN')) return json({error:'Keep at least one platform administrator.'},409);
    console.error('marketplace_request_failed', {path, name:error.name});
    return json({error:'Request failed. Please retry; contact the platform operator if it persists.'},500);
  }
}

export async function verifyContact(message,env) {
  if (!message.contact) return null;
  if (message.chat?.type !== 'private' || !message.from?.id || message.contact.user_id !== message.from.id) {
    return 'Use the Share phone button to share your own Telegram contact.';
  }
  let phone;
  try { phone = phoneValue(message.contact.phone_number); } catch { return 'Your contact must contain an international phone number.'; }
  const telegramId = String(message.from.id);
  const existing = await env.DB.prepare('SELECT * FROM customers WHERE phone=? OR telegram_id=?').bind(phone,telegramId).all();
  if (existing.results.some(user => user.telegram_id !== telegramId || user.phone !== phone)) {
    // Never merge accounts or transfer shops solely because a phone number was recycled.
    return 'This phone or Telegram account is already linked. Contact the platform operator for account recovery.';
  }
  try {
    await env.DB.prepare('INSERT INTO customers (id,phone,telegram_id,name,verified_at) VALUES (?,?,?,?,?) ON CONFLICT(telegram_id) DO NOTHING')
      .bind(id(),phone,telegramId,[message.from.first_name,message.from.last_name].filter(Boolean).join(' ').slice(0,160) || 'Customer',now()).run();
  } catch (error) { if (String(error).includes('UNIQUE')) return 'This phone is already linked. Contact the platform operator for account recovery.'; throw error; }
  return 'Phone verified. Your account works across all shops. Reopen the marketplace or refresh your account.';
}

export function detectImage(bytes) {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0,4))==='RIFF' && new TextDecoder().decode(bytes.slice(8,12))==='WEBP') return 'image/webp';
  return null;
}
async function createOrder(context,user) {
  const {env,request} = context;
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new ApiError(503,'Checkout is unavailable until the platform bot webhook is configured.');
  const requestKey = required(request.headers.get('idempotency-key'),'Idempotency key',80);
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestKey)) throw new ApiError(400,'Invalid idempotency key.');
  const bytes = await limitedBody(request, 3*1048576+65536);
  let form;
  try { form = await new Request(request.url,{method:'POST',headers:{'content-type':request.headers.get('content-type') || ''},body:bytes}).formData(); }
  catch { throw new ApiError(400,'Expected a multipart form.'); }
  const productId = required(form.get('productId'),'Product',80);
  const shopId = required(form.get('shopId'),'Shop',80);
  const quantity = Number(form.get('quantity'));
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new ApiError(400,'Quantity must be an integer between 1 and 20.');
  const note = optional(form.get('note') || '', 'Order note',500);
  const files = form.getAll('attachments');
  if (!files.length || files.length > 3) throw new ApiError(400,'Attach 1–3 payment images.');
  const attachments = [];
  for (const file of files) {
    if (!(file instanceof File) || !file.size || file.size>1048576) throw new ApiError(400,'Each image must be between 1 byte and 1 MB.');
    const content = new Uint8Array(await file.arrayBuffer());
    const mime = detectImage(content);
    if (!mime || mime !== file.type) throw new ApiError(400,'Attach a valid JPG, PNG or WebP image.');
    attachments.push({id:id(),mime,content,hash:await digest(content)});
  }
  const requestHash = await digest(JSON.stringify([shopId,productId,quantity,note,attachments.map(a=>a.hash)]));
  const existing = await env.DB.prepare('SELECT id,request_hash FROM marketplace_orders WHERE customer_id=? AND request_key=?').bind(user.id,requestKey).first();
  if (existing) {
    if (existing.request_hash !== requestHash) throw new ApiError(409,'This request key was already used for a different order.');
    return json({orderId:existing.id,notification:'queued'});
  }
  const product = await env.DB.prepare(`SELECT p.*,s.currency,s.payment_number,s.payment_holder,s.slug,c.telegram_id AS admin_id
    FROM available_products p JOIN shops s ON s.id=p.shop_id JOIN customers c ON c.id=s.owner_id WHERE p.id=? AND p.shop_id=?`).bind(productId,shopId).first();
  if (!product) throw new ApiError(404,'Product not found.');
  const orderId = id();
  const message = `Order ${orderId}\nShop: ${product.slug}\nCustomer: ${user.name}\nPhone: ${user.phone}\n${product.name} × ${quantity}\nTotal: ${(product.price_minor*quantity/100).toFixed(2)} ${product.currency}\n${note}\nReview in your merchant dashboard. Verify the transfer in your bank account.`;
  const statements = [env.DB.prepare(`INSERT INTO marketplace_orders (id,shop_id,customer_id,product_id,product_name,quantity,unit_price_minor,currency,payment_number,payment_holder,customer_note,request_key,request_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(orderId,shopId,user.id,productId,product.name,quantity,product.price_minor,product.currency,product.payment_number,product.payment_holder,note,requestKey,requestHash,now())];
  // One transaction commits the order, every receipt, and all delivery jobs.
  statements.push(notification(env,orderId,null,product.admin_id,message));
  for (const a of attachments) {
    statements.push(env.DB.prepare('INSERT INTO attachments (id,order_id,mime,content) VALUES (?,?,?,?)').bind(a.id,orderId,a.mime,a.content.buffer));
    statements.push(notification(env,orderId,a.id,product.admin_id,`Receipt for order ${orderId}`));
  }
  statements.push(notification(env,orderId,null,user.telegram_id,`Order ${orderId} received by ${product.slug}. Waiting for manual payment review.`));
  try { await env.DB.batch(statements); }
  catch (error) {
    const raced = await env.DB.prepare('SELECT id,request_hash FROM marketplace_orders WHERE customer_id=? AND request_key=?').bind(user.id,requestKey).first();
    if (raced?.request_hash === requestHash) return json({orderId:raced.id,notification:'queued'});
    if (raced) throw new ApiError(409,'This request key was already used for a different order.');
    throw error;
  }
  context.waitUntil(deliverNotifications(env).catch(()=>console.error('notification_dispatch_failed')));
  return json({orderId,notification:'queued'},201);
}
function notification(env,orderId,attachmentId,recipient,message) {
  return env.DB.prepare('INSERT INTO notifications (id,order_id,attachment_id,recipient,message) VALUES (?,?,?,?,?)').bind(id(),orderId,attachmentId,recipient,message);
}
async function reviewOrder(context,shop,user,orderId,body) {
  if (!['ACCEPTED','REJECTED'].includes(body.status)) throw new ApiError(400,'Choose ACCEPTED or REJECTED.');
  let deliveryLink=null;
  if(body.status==='ACCEPTED' && body.delivery_link) {
    try {const url=new URL(required(body.delivery_link,'Delivery URL',1000)); if(url.protocol!=='https:' || url.username || url.password) throw new Error('Invalid URL'); deliveryLink=url.href;}
    catch {throw new ApiError(400,'Delivery link must be a full HTTPS URL without credentials.');}
  }
  const order = await context.env.DB.prepare('SELECT o.*,c.telegram_id FROM marketplace_orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=? AND o.shop_id=?').bind(orderId,shop.id).first();
  if (!order) throw new ApiError(404,'Order not found.');
  if (order.status !== 'WAITING_REVIEW') {
    if (order.status === body.status) return json({ok:true});
    throw new ApiError(409,'Order has already been reviewed.');
  }
  const eventId = id(); const timestamp = now();
  // The event INSERT claims only pending orders. Later statements depend on that claim,
  // so concurrent reviewers cannot enqueue conflicting outcomes.
  const result = await context.env.DB.batch([
    context.env.DB.prepare("INSERT INTO order_events (id,order_id,actor_id,status,created_at) SELECT ?,id,?,?,? FROM marketplace_orders WHERE id=? AND shop_id=? AND status='WAITING_REVIEW'").bind(eventId,user.id,body.status,timestamp,orderId,shop.id),
    context.env.DB.prepare('UPDATE marketplace_orders SET status=?,delivery_link=? WHERE id=? AND EXISTS (SELECT 1 FROM order_events WHERE id=?)').bind(body.status,deliveryLink,orderId,eventId),
    context.env.DB.prepare('INSERT INTO notifications (id,order_id,recipient,message) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM order_events WHERE id=?)').bind(id(),orderId,order.telegram_id,`Order ${orderId}: ${body.status === 'ACCEPTED' ? 'payment approved' : 'payment not approved'}. Shop: ${shop.name}.${deliveryLink ? '\nYour product link: '+deliveryLink : ''}`,eventId)
  ]);
  if (!result[0].meta.changes) throw new ApiError(409,'Order was reviewed by another request. Refresh the list.');
  context.waitUntil(deliverNotifications(context.env).catch(()=>console.error('notification_dispatch_failed')));
  return json({ok:true});
}
async function importProduct(context) {
  const token = (context.request.headers.get('authorization') || '').replace(/^Bearer /,'');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401,'Invalid integration token.');
  const integration = await context.env.DB.prepare('SELECT i.shop_id,s.currency,s.status FROM shop_integrations i JOIN shops s ON s.id=i.shop_id WHERE i.token_hash=?').bind(await digest(token)).first();
  if (!integration) throw new ApiError(401,'Invalid integration token.');
  if(integration.status==='SUSPENDED') throw new ApiError(403,'Shop is suspended. Contact platform support.');
  const body = await bodyJson(context.request);
  await rateLimit(context.env,'integration:'+integration.shop_id,120);
  const sourceId = required(String(body.source_id || ''),'WooCommerce product ID',40);
  if (!/^\d+$/.test(sourceId)) throw new ApiError(400,'Invalid WooCommerce product ID.');
  if (body.currency !== integration.currency) throw new ApiError(400,'WooCommerce currency must match the shop currency.');
  if (!Number.isSafeInteger(body.version) || body.version < 1) throw new ApiError(400,'Product version is required.');
  const fields = productFields(body);
  const archived=body.archived===true ? 1 : 0;
  await context.env.DB.prepare(`INSERT INTO products (id,shop_id,source_id,name,description,price_minor,active,source_version,archived) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(shop_id,source_id) DO UPDATE SET name=excluded.name,description=excluded.description,price_minor=excluded.price_minor,active=excluded.active,source_version=excluded.source_version,archived=excluded.archived
    WHERE excluded.source_version>products.source_version`).bind(id(),integration.shop_id,sourceId,...fields,body.version,archived).run();
  return json({ok:true});
}
