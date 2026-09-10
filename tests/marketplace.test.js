import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { marketplace, verifyContact, priceMinor, phoneValue, slugValue, detectImage, digest } from '../lib/marketplace.js';
import { validateTelegramInitData, onRequest } from '../functions/api/[[path]].js';
import { deliverNotifications } from '../lib/notifications.js';
import { createRequestScope } from '../public/request-client.js';

class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    for (const migration of ['0001_init.sql','0002_marketplace.sql','0003_shop_management.sql','0004_public_catalog_sessions.sql']) this.sqlite.exec(readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8'));
  }
  prepare(sql) {
    const db=this.sqlite; let values=[];
    const args=()=>values.map(v=>v instanceof ArrayBuffer ? new Uint8Array(v) : v);
    return {
      bind(...next) {values=next; return this;},
      async first() {return db.prepare(sql).get(...args()) || null;},
      async all() {return {results:db.prepare(sql).all(...args())};},
      async run() {const r=db.prepare(sql).run(...args()); return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},
      syncRun() {const r=db.prepare(sql).run(...args()); return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {const results=statements.map(s=>s.syncRun()); this.sqlite.exec('COMMIT'); return results;}
    catch(e) {this.sqlite.exec('ROLLBACK'); throw e;}
  }
}
async function initData(userId=1,extras={},token='test-token') {
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:userId,first_name:'User '+userId}),...extras});
  const enc=new TextEncoder();
  const first=await crypto.subtle.importKey('raw',enc.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const secret=await crypto.subtle.sign('HMAC',first,enc.encode(token));
  const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const hash=await crypto.subtle.sign('HMAC',key,enc.encode([...params].map(([k,v])=>`${k}=${v}`).sort().join('\n')));
  params.set('hash',[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')); return params.toString();
}
function fixture() {
  const env={DB:new D1(),BOT_TOKEN:'test-token',TELEGRAM_WEBHOOK_SECRET:'test-secret',BOT_USERNAME:'shop_bot'};
  env.DB.sqlite.exec(`INSERT INTO customers VALUES ('c1','+447700900001','1','Owner',1),('c2','+447700900002','2','Buyer',1),('c3','+447700900003','3','Other owner',1);
    INSERT INTO shops (id,slug,owner_id,name,description,currency,payment_number,payment_holder,payment_note,created_at,status) VALUES ('s1','first-shop','c1','First','','USD','1234567812345678','Owner','',1,'APPROVED'),('s2','other-shop','c3','Other','','USD','2222222222222222','Other','',1,'APPROVED');
    INSERT INTO products (id,shop_id,source_id,name,description,price_minor,active,source_version) VALUES ('p1','s1',NULL,'Product','',1234,1,0),('p2','s2',NULL,'Other','',9876,1,0);`);
  const pending=[];
  const authTokens=new Map();
  const call=async(path,{method='GET',body,user=2,headers={},...rest}={})=>{
    if(!authTokens.has(user)) {
      const result=await marketplace({env,request:new Request('https://market.example/api/v1/auth/session',{method:'POST',headers:{authorization:'Telegram '+await initData(user)}})},validateTelegramInitData);
      authTokens.set(user,(await result.json()).token || '');
    }
    const h=new Headers(headers); h.set('authorization','Bearer '+authTokens.get(user));
    if(body && !(body instanceof FormData)) {h.set('content-type','application/json'); body=JSON.stringify(body);}
    const request=new Request('https://market.example/api/v1'+path,{method,headers:h,body,...rest});
    return marketplace({request,env,waitUntil:p=>pending.push(p)},validateTelegramInitData);
  };
  return {env,call,pending,authTokens};
}
const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
function orderForm(shop='s1',product='p1',note='') {
  const form=new FormData(); form.set('shopId',shop); form.set('productId',product); form.set('quantity','2'); form.set('note',note);
  form.append('attachments',new File([png],'proof.png',{type:'image/png'})); return form;
}
const orderOptions=(form=orderForm(),key='request-key-12345678')=>({method:'POST',body:form,headers:{'idempotency-key':key}});
// No test contacts Telegram or another external service.
globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:{message_id:42}}),{status:200});

test('integer money and strict phone, slug, image validation',()=>{
  assert.equal(priceMinor('12.34'),1234); assert.equal(priceMinor('0.01'),1);
  for(const value of ['-1','1.234','NaN','1e2','']) assert.throws(()=>priceMinor(value));
  assert.equal(phoneValue('447700900001'),'+447700900001'); assert.throws(()=>phoneValue('0044 7700'));
  assert.equal(slugValue('my-shop'),'my-shop'); for(const slug of ['merchant','ab','../shop','MixedCase']) assert.throws(()=>slugValue(slug));
  assert.equal(detectImage(png),'image/png'); assert.equal(detectImage(new TextEncoder().encode('<svg>')),null);
});
test('Telegram HMAC validates signature field, rejects tampering, duplicate and stale fields',async()=>{
  const valid=await initData(2,{signature:'included-in-HMAC'});
  assert.equal((await validateTelegramInitData(valid,'test-token')).ok,true);
  assert.equal((await validateTelegramInitData(valid.replace('included-in-HMAC','tampered'),'test-token')).ok,false);
  assert.equal((await validateTelegramInitData(valid+'&user={}','test-token')).ok,false);
  assert.equal((await validateTelegramInitData(await initData(2,{auth_date:'1'}),'test-token')).ok,false);
  assert.equal((await validateTelegramInitData(await initData(2,{auth_date:String(Math.floor(Date.now()/1000)+600)}),'test-token')).ok,false);
});
test('phone verification refuses contacts belonging to another person and recycled account merges',async()=>{
  const {env}=fixture();
  const message={chat:{type:'private'},from:{id:4,first_name:'New'},contact:{user_id:3,phone_number:'447700900004'}};
  assert.match(await verifyContact(message,env),/own Telegram/);
  message.contact.user_id=4; message.contact.phone_number='447700900001'; assert.match(await verifyContact(message,env),/already linked/);
  message.contact.phone_number='447700900004'; assert.match(await verifyContact(message,env),/Phone verified/);
  assert.match(await verifyContact(message,env),/Phone verified/);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS n FROM customers').get().n,4);
});
test('merchant product and order endpoints enforce ownership',async()=>{
  const {call}=fixture();
  assert.equal((await call('/merchant/s1/products',{user:3})).status,404);
  assert.equal((await call('/merchant/s1/orders',{user:3})).status,404);
  assert.equal((await call('/merchant/s1/products',{user:1,method:'POST',body:{name:'Manual',price:'2.50'}})).status,201);
  assert.equal((await call('/merchant/s2/products/p1',{user:3,method:'PATCH',body:{name:'Stolen',price:'0'}})).status,404);
  assert.equal((await call('/shops',{user:4,method:'POST',body:{}})).status,401);
});
test('shop creation persists bank profile, duplicate username conflicts and currency is immutable',async()=>{
  const {call,env}=fixture(); const body={slug:'new-store',name:'New',currency:'USD',payment_number:'1111222233334444',payment_holder:'Owner'};
  const created=await call('/shops',{user:1,method:'POST',body}); assert.equal(created.status,201); const {id}=await created.json();
  assert.equal((await call('/shops',{user:3,method:'POST',body})).status,409);
  assert.equal(env.DB.sqlite.prepare('SELECT payment_number FROM shops WHERE id=?').get(id).payment_number,body.payment_number);
  assert.equal((await call('/merchant/'+id,{user:1,method:'PATCH',body:{...body,currency:'EUR'}})).status,400);
});
test('order transaction saves receipt, authoritative prices and jobs; retries create no duplicate',async()=>{
  const {call,env,pending}=fixture();
  const response=await call('/orders',orderOptions()); assert.equal(response.status,201); const {orderId}=await response.json(); await Promise.all(pending);
  const repeat=await call('/orders',orderOptions()); assert.equal((await repeat.json()).orderId,orderId);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM marketplace_orders').get().n,1);
  const order=env.DB.sqlite.prepare('SELECT * FROM marketplace_orders').get(); assert.equal(order.unit_price_minor,1234); assert.equal(order.payment_holder,'Owner');
  assert.deepEqual([...env.DB.sqlite.prepare('SELECT content FROM attachments').get().content],[...png]);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM notifications').get().n,3);
  assert.equal((await call('/orders',orderOptions(orderForm('s1','p1','Changed')))).status,409);
  assert.equal((await call('/orders',orderOptions(orderForm('s1','p2'),'request-key-other-12'))).status,404);
});
test('receipt downloads are private to order customer and shop owner',async()=>{
  const {call,pending}=fixture(); const {orderId}=await (await call('/orders',orderOptions())).json(); await Promise.all(pending);
  assert.equal((await call(`/orders/${orderId}/attachments`,{user:3})).status,404);
  const {attachments}=await (await call(`/orders/${orderId}/attachments`,{user:1})).json();
  const download=await call(`/orders/${orderId}/attachments/${attachments[0].id}`,{user:2});
  assert.equal(download.status,200); assert.equal(download.headers.get('cache-control'),'private, no-store'); assert.deepEqual([...new Uint8Array(await download.arrayBuffer())],[...png]);
});
test('invalid quantity and forged image MIME cannot create orders',async()=>{
  const {call,env}=fixture(); const form=orderForm(); form.set('quantity','1.5'); assert.equal((await call('/orders',orderOptions(form))).status,400);
  const forged=orderForm(); forged.set('attachments',new File(['not an image'],'fake.png',{type:'image/png'})); assert.equal((await call('/orders',orderOptions(forged))).status,400);
  const huge=orderForm(); huge.set('attachments',new File([new Uint8Array(1048577)],'big.png',{type:'image/png'})); assert.equal((await call('/orders',orderOptions(huge))).status,400);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM marketplace_orders').get().n,0);
});
test('failed attachment insert rolls back order and notifications',async()=>{
  const {call,env}=fixture(); env.DB.sqlite.exec("CREATE TRIGGER reject_file BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;");
  assert.equal((await call('/orders',orderOptions())).status,500);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM marketplace_orders').get().n,0);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM notifications').get().n,0);
});
test('review is terminal, audited and scoped, and duplicate review does not enqueue twice',async()=>{
  const {call,env,pending}=fixture(); const {orderId}=await (await call('/orders',orderOptions())).json(); await Promise.all(pending);
  const path=`/merchant/s1/orders/${orderId}`; const review={method:'PATCH',body:{status:'ACCEPTED',delivery_link:'https://example.com/private-product'},user:1};
  assert.equal((await call(path,{...review,body:{status:'ACCEPTED',delivery_link:'javascript:alert(1)'}})).status,400);
  assert.equal((await call(path,{...review,user:3})).status,404);
  assert.equal((await call(path,review)).status,200); await Promise.all(pending);
  assert.equal((await call(path,review)).status,200);
  assert.equal((await call(path,{...review,body:{status:'REJECTED'}})).status,409);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM order_events').get().n,1);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM notifications').get().n,4);
  assert.equal(env.DB.sqlite.prepare('SELECT delivery_link FROM marketplace_orders').get().delivery_link,'https://example.com/private-product');
});
test('WooCommerce token determines tenant, older snapshots cannot overwrite newer products, revoke works',async()=>{
  const {call,env}=fixture(); const tokenResponse=await call('/merchant/s1/integration',{method:'POST',user:1}); const {token}=await tokenResponse.json();
  const imported=async(body,credential=token)=>marketplace({env,request:new Request('https://market.example/api/v1/integrations/woocommerce',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(body)})},validateTelegramInitData);
  const body={source_id:'10',name:'Woo product',price:'20.00',currency:'USD',version:2,active:true,shop_id:'s2'};
  assert.equal((await imported(body)).status,200); assert.equal((await imported({...body,version:1,price:'1.00'})).status,200);
  const product=env.DB.sqlite.prepare("SELECT * FROM products WHERE source_id='10'").get(); assert.equal(product.shop_id,'s1'); assert.equal(product.price_minor,2000);
  assert.notEqual(env.DB.sqlite.prepare('SELECT token_hash FROM shop_integrations').get().token_hash,token);
  await call('/merchant/s1/integration',{method:'DELETE',user:1}); assert.equal((await imported(body)).status,401);
});
test('notification timeout preserves jobs with backoff, successful retry acknowledges delivery',async()=>{
  const {call,env,pending}=fixture(); await call('/orders',orderOptions()); await Promise.all(pending);
  env.DB.sqlite.exec("UPDATE notifications SET state='PENDING',next_attempt=0,attempts=0");
  const original=globalThis.fetch; globalThis.fetch=async()=>{throw new Error('network unavailable');};
  try {await deliverNotifications(env);} finally {globalThis.fetch=original;}
  const job=env.DB.sqlite.prepare('SELECT * FROM notifications LIMIT 1').get(); assert.equal(job.state,'PENDING'); assert.equal(job.attempts,1); assert.ok(job.next_attempt>Math.floor(Date.now()/1000));
  env.DB.sqlite.exec('UPDATE notifications SET next_attempt=0'); await deliverNotifications(env);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) n FROM notifications WHERE state='SENT'").get().n,3);
});
test('public configuration reports checkout unavailable without token; async exceptions are caught',async()=>{
  const {env,call}=fixture(); delete env.BOT_TOKEN;
  assert.equal((await (await call('/config')).json()).checkoutAvailable,false);
  assert.equal((await call('/orders',orderOptions())).status,503);
  const response=await onRequest({env,request:new Request('https://market.example/api/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-secret'},body:'invalid'})});
  assert.equal(response.status,500);
});
test('concurrent duplicate submits preserve one order and one set of receipts',async()=>{
  const {call,env,pending}=fixture();
  const responses=await Promise.all([call('/orders',orderOptions()),call('/orders',orderOptions())]);
  const bodies=await Promise.all(responses.map(r=>r.json())); await Promise.all(pending);
  assert.equal(bodies[0].orderId,bodies[1].orderId);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM marketplace_orders').get().n,1);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM attachments').get().n,1);
});
test('mutation rate limits are enforced and non-object JSON is rejected',async()=>{
  const {call}=fixture();
  assert.equal((await call('/merchant/s1/products',{user:1,method:'POST',body:[]})).status,400);
  for(let i=0;i<29;i++) await call('/merchant/s1/products',{user:1,method:'POST',body:{name:'P',price:'1'}});
  assert.equal((await call('/merchant/s1/products',{user:1,method:'POST',body:{name:'P',price:'1'}})).status,429);
});

function grantAdmin(env) {
  env.DB.sqlite.exec("INSERT INTO customers VALUES ('admin','+447700900009','9','Platform Admin',1); INSERT INTO platform_admins VALUES ('admin',1);");
}
test('super-admin is explicit; shop signup cannot self-approve or grant an elevated plan',async()=>{
  const {call,env}=fixture();
  assert.equal((await call('/admin/overview',{user:1})).status,403);
  grantAdmin(env); assert.equal((await call('/admin/overview',{user:9})).status,200);
  assert.equal((await (await call('/me',{user:9})).json()).isSuperAdmin,true);
  const body={slug:'pending-shop',name:'Pending',currency:'USD',payment_number:'1111222233334444',payment_holder:'Owner',status:'APPROVED',plan_id:'pro',isSuperAdmin:true};
  const result=await (await call('/shops',{user:1,method:'POST',body})).json();
  const shop=env.DB.sqlite.prepare('SELECT * FROM shops WHERE id=?').get(result.id);
  assert.equal(shop.status,'PENDING'); assert.equal(shop.plan_id,'free');
  assert.equal((await call('/shops/pending-shop')).status,404);
  assert.equal((await (await call('/me',{user:1})).json()).isSuperAdmin,false);
});
test('shop approval and suspension gate storefront and checkout with audited conflict protection',async()=>{
  const {call,env,pending}=fixture(); grantAdmin(env);
  const path='/admin/shops/s1';
  const decision={method:'PATCH',user:9,body:{status:'SUSPENDED',revision:0,note:'Review required'}};
  assert.equal((await call(path,decision)).status,200);
  assert.equal((await call('/shops/first-shop')).status,404);
  assert.equal((await call('/orders',orderOptions())).status,404);
  assert.equal((await call(path,{...decision,body:{status:'APPROVED',revision:0,note:'Stale'}})).status,409);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM audit_events').get().n,1);
  assert.equal((await call(path,{...decision,body:{status:'APPROVED',revision:1,note:'Verified'}})).status,200);
  assert.equal((await call('/shops/first-shop')).status,200);
  assert.equal((await call('/orders',orderOptions())).status,201); await Promise.all(pending);
});
test('seller profile changes return an approved shop to pending and cannot bypass suspension',async()=>{
  const {call,env}=fixture();
  const body={name:'Updated',description:'',currency:'USD',payment_number:'1111222233334444',payment_holder:'Owner',revision:0,status:'APPROVED'};
  assert.equal((await call('/merchant/s1',{user:1,method:'PATCH',body})).status,200);
  assert.equal(env.DB.sqlite.prepare("SELECT status FROM shops WHERE id='s1'").get().status,'PENDING');
  env.DB.sqlite.exec("UPDATE shops SET status='SUSPENDED' WHERE id='s1'");
  assert.equal((await call('/merchant/s1',{user:1,method:'PATCH',body:{...body,revision:1}})).status,200);
  assert.equal(env.DB.sqlite.prepare("SELECT status FROM shops WHERE id='s1'").get().status,'SUSPENDED');
});
test('the free product quota is atomic and archiving frees a slot',async()=>{
  const {call,env}=fixture();
  for(let i=0;i<8;i++) assert.equal((await call('/merchant/s1/products',{user:1,method:'POST',body:{name:'P'+i,price:'1'}})).status,201);
  const results=await Promise.all([1,2].map(()=>call('/merchant/s1/products',{user:1,method:'POST',body:{name:'Concurrent',price:'1',plan_id:'pro'}})));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) n FROM products WHERE shop_id='s1' AND archived=0").get().n,10);
  await call('/merchant/s1/products/p1',{method:'DELETE',user:1});
  assert.equal((await call('/merchant/s1/products',{user:1,method:'POST',body:{name:'Replacement',price:'1'}})).status,201);
  assert.equal((await call('/merchant/s1/products/p1',{user:1,method:'PATCH',body:{name:'Restored',price:'1'}})).status,409);
});
test('WooCommerce updates at quota work but new products and archived restores cannot bypass quota',async()=>{
  const {call,env}=fixture();
  const {token}=await (await call('/merchant/s1/integration',{method:'POST',user:1})).json();
  const imported=body=>marketplace({env,request:new Request('https://market.example/api/v1/integrations/woocommerce',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)})},validateTelegramInitData);
  const body={source_id:'101',name:'Woo',price:'1',currency:'USD',version:1};
  assert.equal((await imported(body)).status,200);
  for(let i=0;i<8;i++) await call('/merchant/s1/products',{user:1,method:'POST',body:{name:'P'+i,price:'1'}});
  assert.equal((await imported({...body,version:2,price:'2'})).status,200);
  assert.equal((await imported({...body,source_id:'102'})).status,409);
  assert.equal((await imported({...body,version:3,archived:true,active:false})).status,200);
  await call('/merchant/s1/products',{user:1,method:'POST',body:{name:'Replacement',price:'1'}});
  assert.equal((await imported({...body,version:4,archived:false})).status,409);
});
test('plan publishing and paid assignment are admin-only and expired subscriptions fall back to ten',async()=>{
  const {call,env,pending}=fixture(); grantAdmin(env);
  assert.equal((await (await call('/plans')).json()).plans.length,1);
  const plan={name:'Pro',product_limit:20,monthly_price_minor:1000,currency:'USD',published:true,revision:0};
  assert.equal((await call('/admin/plans/pro',{user:1,method:'PATCH',body:plan})).status,403);
  assert.equal((await call('/admin/plans/free',{user:9,method:'PATCH',body:plan})).status,400);
  assert.equal((await call('/admin/plans/pro',{user:9,method:'PATCH',body:plan})).status,200);
  assert.equal((await (await call('/plans')).json()).plans.length,2);
  assert.equal((await call('/admin/shops/s1/plan',{user:9,method:'PATCH',body:{plan_id:'pro',expires_at:Math.floor(Date.now()/1000)+86400,revision:0,note:'Payment reference TEST-1'}})).status,200);
  for(let i=0;i<10;i++) assert.equal((await call('/merchant/s1/products',{user:1,method:'POST',body:{name:'Paid '+i,price:'1'}})).status,201);
  const last=env.DB.sqlite.prepare("SELECT id FROM products WHERE shop_id='s1' ORDER BY rowid DESC LIMIT 1").get().id;
  env.DB.sqlite.exec("UPDATE shops SET plan_expires_at=1 WHERE id='s1'");
  assert.equal((await (await call('/merchant/s1/usage',{user:1})).json()).usage.product_limit,10);
  assert.equal((await (await call('/shops/first-shop')).json()).products.length,10);
  assert.equal((await call('/orders',orderOptions(orderForm('s1',last)))).status,404);
  assert.equal((await call('/orders',orderOptions())).status,201); await Promise.all(pending);
});
test('categories stay shop-scoped and removal unassigns rather than deletes products',async()=>{
  const {call,env}=fixture();
  const category=await (await call('/merchant/s1/categories',{user:1,method:'POST',body:{name:'Books'}})).json();
  assert.equal((await call('/merchant/s2/categories/'+category.id,{user:3,method:'PATCH',body:{name:'Stolen'}})).status,404);
  assert.equal((await call('/merchant/s2/products/p2',{user:3,method:'PATCH',body:{category_id:category.id}})).status,400);
  assert.equal((await call('/merchant/s1/products/p1',{user:1,method:'PATCH',body:{category_id:category.id}})).status,200);
  assert.equal((await (await call('/shops/first-shop?category='+category.id)).json()).products.length,1);
  assert.equal((await call('/merchant/s1/categories/'+category.id,{user:1,method:'DELETE'})).status,200);
  assert.equal(env.DB.sqlite.prepare("SELECT category_id FROM products WHERE id='p1'").get().category_id,null);
});
test('seller customer directory only includes their buyers and their own order totals',async()=>{
  const {call,env,pending}=fixture(); await call('/orders',orderOptions()); await Promise.all(pending);
  const data=await (await call('/merchant/s1/customers',{user:1})).json();
  assert.equal(data.customers.length,1); assert.equal(data.customers[0].id,'c2'); assert.equal(data.customers[0].order_count,1);
  assert.equal((await (await call('/merchant/s2/customers',{user:3})).json()).customers.length,0);
  assert.equal((await call('/merchant/s1/customers',{user:3})).status,404);
});
test('support messages are private to ticket participants and platform admins',async()=>{
  const {call,env,pending}=fixture(); grantAdmin(env);
  const {orderId}=await (await call('/orders',orderOptions())).json(); await Promise.all(pending);
  const create=audience=>call('/support',{method:'POST',body:{order_id:orderId,audience,subject:'Receipt question',message:'Please check my receipt.'}});
  const shared=await (await create('SHOP')).json(); const privateTicket=await (await create('PLATFORM')).json();
  assert.equal((await call('/support/'+shared.id,{user:1})).status,200);
  assert.equal((await call('/support/'+shared.id,{user:3})).status,404);
  assert.equal((await call('/support/'+privateTicket.id,{user:1})).status,404);
  assert.equal((await call('/support/'+privateTicket.id,{user:9})).status,200);
  assert.equal((await call('/support',{user:3,method:'POST',body:{order_id:orderId,subject:'Forged',message:'No access'}})).status,404);
  assert.equal((await call('/support/'+shared.id+'/messages',{user:3,method:'POST',body:{message:'Intruder'}})).status,404);
  assert.equal((await call('/support/'+shared.id+'/messages',{user:1,method:'POST',body:{message:'Seller reply'}})).status,201);
  const ticket=(await (await call('/support/'+shared.id)).json()).ticket;
  assert.equal((await call('/support/'+shared.id,{user:1,method:'PATCH',body:{status:'RESOLVED',revision:ticket.revision}})).status,403);
  assert.equal((await call('/support/'+shared.id,{user:9,method:'PATCH',body:{status:'RESOLVED',revision:ticket.revision}})).status,200);
  assert.equal((await call('/support/'+shared.id+'/messages',{method:'POST',body:{message:'Too late'}})).status,409);
});
test('platform support can start a private conversation for a seller but other users cannot impersonate requesters',async()=>{
  const {call,env}=fixture(); grantAdmin(env);
  const body={shop_id:'s1',requester_id:'c1',subject:'Shop verification',message:'Please correct your profile.',audience:'PLATFORM'};
  const response=await call('/support',{user:9,method:'POST',body}); assert.equal(response.status,201); const {id}=await response.json();
  assert.equal((await call('/support/'+id,{user:1})).status,200);
  assert.equal((await call('/support/'+id,{user:2})).status,404);
  assert.equal((await call('/support',{user:2,method:'POST',body:{subject:'Forged',message:'No',requester_id:'c1'}})).status,403);
});
test('super admin can inspect receipts and requeue only failed notifications',async()=>{
  const {call,env,pending}=fixture(); grantAdmin(env);
  const {orderId}=await (await call('/orders',orderOptions())).json(); await Promise.all(pending);
  assert.equal((await call(`/orders/${orderId}/attachments`,{user:9})).status,200);
  env.DB.sqlite.exec("UPDATE notifications SET state='FAILED' WHERE rowid=(SELECT min(rowid) FROM notifications)");
  const retry=await call(`/admin/orders/${orderId}/retry-notifications`,{user:9,method:'POST',body:{note:'Bot access restored'}});
  assert.equal((await retry.json()).requeued,1);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) n FROM notifications WHERE state='SENT'").get().n,2);
});
test('management migration upgrades an existing marketplace without deleting shop or order history',()=>{
  const db=new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0001_init.sql','0002_marketplace.sql']) db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  db.exec("INSERT INTO customers VALUES ('c','+447700900001','1','Owner',1); INSERT INTO shops VALUES ('s','existing','c','Existing','','USD','1111222233334444','Owner','',1); INSERT INTO products VALUES ('p','s',NULL,'Product','',100,1,0);");
  db.exec("INSERT INTO marketplace_orders (id,shop_id,customer_id,product_id,product_name,quantity,unit_price_minor,currency,payment_number,payment_holder,request_key,request_hash,created_at) VALUES ('o','s','c','p','Product',1,100,'USD','1111222233334444','Owner','old-key','old-hash',1);");
  db.exec(readFileSync(new URL('../migrations/0003_shop_management.sql',import.meta.url),'utf8'));
  assert.equal(db.prepare('SELECT count(*) n FROM products').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM marketplace_orders').get().n,1);
  assert.equal(db.prepare('SELECT status FROM shops').get().status,'PENDING');
  assert.equal(db.prepare('SELECT product_limit FROM shop_entitlements').get().product_limit,10);
  db.close();
});
test('public catalog is explicit opt-in, tenant scoped and removed when a shop is suspended',async()=>{
  const {call,env}=fixture();
  assert.equal((await (await call('/catalog')).json()).products.length,0);
  assert.equal((await call('/merchant/s1/products/p1',{method:'PATCH',user:3,body:{isPublic:true}})).status,404);
  assert.equal((await call('/merchant/s1/products/p1',{method:'PATCH',user:1,body:{isPublic:'true'}})).status,400);
  await call('/merchant/s1/products/p1',{method:'PATCH',user:1,body:{isPublic:true}});
  const catalog=await (await call('/catalog')).json(); assert.equal(catalog.products.length,1); assert.equal(catalog.products[0].shop_slug,'first-shop');
  env.DB.sqlite.exec("UPDATE shops SET status='SUSPENDED' WHERE id='s1'");
  assert.equal((await (await call('/catalog')).json()).products.length,0);
});
test('catalog filters validate currency, price range, sort and seller boundaries',async()=>{
  const {call}=fixture();
  await call('/merchant/s1/products/p1',{method:'PATCH',user:1,body:{isPublic:true}});
  assert.equal((await call('/catalog?sort=price_asc')).status,400);
  assert.equal((await call('/catalog?currency=USD&min=20&max=10')).status,400);
  assert.equal((await call('/catalog?sort=unknown')).status,400);
  assert.equal((await (await call('/catalog?currency=USD&min=12&max=13&q=product&sort=price_asc')).json()).total,1);
  assert.equal((await (await call('/catalog?seller=other-shop')).json()).total,0);
  assert.equal((await (await call('/shops/first-shop?min=13')).json()).total,0);
  assert.equal((await (await call('/shops/first-shop?sort=price_desc')).json()).total,1);
});
test('WooCommerce sync cannot opt a product in or reset a seller visibility choice',async()=>{
  const {call,env}=fixture(); const {token}=await (await call('/merchant/s1/integration',{method:'POST',user:1})).json();
  const send=body=>marketplace({env,request:new Request('https://market.example/api/v1/integrations/woocommerce',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)})},validateTelegramInitData);
  const body={source_id:'201',name:'Imported',price:'5',currency:'USD',version:1,isPublic:true}; await send(body);
  const product=env.DB.sqlite.prepare("SELECT * FROM products WHERE source_id='201'").get(); assert.equal(product.is_public,0);
  await call('/merchant/s1/products/'+product.id,{user:1,method:'PATCH',body:{isPublic:true}});
  await send({...body,version:2,isPublic:false}); assert.equal(env.DB.sqlite.prepare('SELECT is_public FROM products WHERE id=?').get(product.id).is_public,1);
});
test('session revocation is immediate and a revoked Telegram proof cannot reissue access',async()=>{
  const {call,env}=fixture();
  const proof=await initData(2,{query_id:'revocation-test'});
  const exchange=()=>marketplace({env,request:new Request('https://market.example/api/v1/auth/session',{method:'POST',headers:{authorization:'Telegram '+proof}})},validateTelegramInitData);
  const first=await (await exchange()).json(); const second=await (await exchange()).json(); assert.equal(first.token,second.token);
  await call('/sessions/'+first.sessionId,{method:'DELETE'});
  assert.equal((await exchange()).status,401);
  const response=await marketplace({env,request:new Request('https://market.example/api/v1/me',{headers:{authorization:'Bearer '+first.token}})},validateTelegramInitData); assert.equal(response.status,401);
});
test('session identities do not mix and cannot revoke another customer session',async()=>{
  const {call,env,authTokens}=fixture(); await call('/me',{user:1}); await call('/me',{user:2});
  assert.notEqual(authTokens.get(1),authTokens.get(2));
  const sessions=await (await call('/sessions',{user:1})).json();
  assert.equal((await (await call('/sessions/'+sessions.currentSessionId,{method:'DELETE',user:2})).json()).revoked,0);
  assert.equal((await (await call('/me',{user:1})).json()).customer.id,'c1');
  const raw=await marketplace({env,request:new Request('https://market.example/api/v1/me',{headers:{authorization:'Telegram '+await initData(1)}})},validateTelegramInitData); assert.equal(raw.status,401);
  env.DB.sqlite.exec("UPDATE auth_sessions SET expires_at=1 WHERE customer_id='c1'"); assert.equal((await call('/me',{user:1})).status,401);
});
test('permission manager protects the last admin and revokes sessions on demotion',async()=>{
  const {call,env}=fixture(); grantAdmin(env);
  const endpoint='/admin/permissions';
  assert.equal((await call(endpoint,{user:1})).status,403);
  assert.equal((await call(endpoint,{user:9,method:'PATCH',body:{phone:'+447700900009',admin:false,expected_admin:true,note:'Test'}})).status,409);
  assert.equal((await call(endpoint,{user:9,method:'PATCH',body:{phone:'+447700900001',admin:true,expected_admin:false,note:'Trusted operator'}})).status,200);
  assert.equal((await call('/admin/overview',{user:1})).status,200);
  assert.equal((await call(endpoint,{user:9,method:'PATCH',body:{phone:'+447700900001',admin:false,expected_admin:true,note:'Access ended'}})).status,200);
  assert.equal((await call('/admin/overview',{user:1})).status,401);
});
test('stale view requests are cancelled and cannot apply a late response',()=>{
  const scope=createRequestScope(); const first=scope.begin(); const capture=scope.capture(); scope.begin();
  assert.equal(scope.current(first),false); assert.equal(capture.signal.aborted,true);
  assert.throws(()=>capture.assertCurrent(),{name:'AbortError'}); assert.doesNotThrow(()=>scope.capture().assertCurrent());
});
