const now = () => Math.floor(Date.now()/1000);
const uuid = () => crypto.randomUUID();

export async function isSuperAdmin(env,user) {
  return Boolean(user && await env.DB.prepare('SELECT customer_id FROM platform_admins WHERE customer_id=?').bind(user.id).first());
}
export async function shopUsage(env,shopId) {
  return env.DB.prepare(`SELECT e.*,p.name AS plan_name,
    (SELECT count(*) FROM products WHERE shop_id=e.shop_id AND archived=0) AS product_count
    FROM shop_entitlements e JOIN plans p ON p.id=e.effective_plan_id WHERE e.shop_id=?`).bind(shopId).first();
}

// Transport helpers are passed by the API entry point to keep a single validation/error contract.
export async function management(context,user,helpers) {
  const {json,ApiError,bodyJson,required,optional,pageOffset,ownedShop} = helpers;
  const {env,request}=context;
  const url=new URL(request.url); const path=url.pathname.replace('/api/v1','');
  if(!path.startsWith('/admin') && !path.startsWith('/support') && !/^\/merchant\/[^/]+\/(categories|customers|usage)/.test(path)) return null;
  const admin=await isSuperAdmin(env,user);
  function version(body) {if(!Number.isSafeInteger(body.revision) || body.revision<0) throw new ApiError(400,'Refresh this record and provide its revision.'); return body.revision;}
  function audit(type,entity,action,detail,condition='1',args=[]) {
    const eventId=uuid();
    return {id:eventId,statement:env.DB.prepare(`INSERT INTO audit_events (id,actor_id,entity_type,entity_id,action,detail,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${condition}`).bind(eventId,user.id,type,entity,action,JSON.stringify(detail),now(),...args)};
  }
  if(path.startsWith('/admin')) {
    if(!admin) throw new ApiError(403,'Super admin access required.');
    if(path==='/admin/overview' && request.method==='GET') return json(await env.DB.prepare(`SELECT
      (SELECT count(*) FROM shops WHERE status='PENDING') AS pending_shops,
      (SELECT count(*) FROM shops WHERE status='APPROVED') AS approved_shops,
      (SELECT count(*) FROM marketplace_orders) AS orders,
      (SELECT count(*) FROM customers) AS customers,
      (SELECT count(*) FROM support_tickets WHERE status<>'RESOLVED') AS open_tickets,
      (SELECT count(*) FROM notifications WHERE state='FAILED') AS failed_notifications`).first());
    if(path==='/admin/shops' && request.method==='GET') {
      const status=url.searchParams.get('status') || '';
      if(status && !['PENDING','APPROVED','REJECTED','SUSPENDED'].includes(status)) throw new ApiError(400,'Invalid shop status.');
      return json({shops:(await env.DB.prepare(`SELECT s.*,c.name AS owner_name,c.phone AS owner_phone,e.product_limit,e.effective_plan_id,
        (SELECT count(*) FROM products p WHERE p.shop_id=s.id AND p.archived=0) AS product_count
        FROM shops s JOIN customers c ON c.id=s.owner_id JOIN shop_entitlements e ON e.shop_id=s.id
        WHERE (?='' OR s.status=?) ORDER BY s.created_at DESC,s.id LIMIT 50 OFFSET ?`).bind(status,status,pageOffset(url)).all()).results});
    }
    const shopMatch=path.match(/^\/admin\/shops\/([^/]+)(?:\/(plan|audit))?$/);
    if(shopMatch) {
      const shop=await env.DB.prepare('SELECT * FROM shops WHERE id=?').bind(shopMatch[1]).first();
      if(!shop) throw new ApiError(404,'Shop not found.');
      if(shopMatch[2]==='audit' && request.method==='GET') return json({events:(await env.DB.prepare("SELECT a.*,c.name AS actor_name FROM audit_events a JOIN customers c ON c.id=a.actor_id WHERE a.entity_type='shop' AND a.entity_id=? ORDER BY a.rowid DESC LIMIT 50 OFFSET ?").bind(shop.id,pageOffset(url)).all()).results});
      if(request.method==='PATCH' && !shopMatch[2]) {
        const body=await bodyJson(request); const revision=version(body);
        if(!['APPROVED','REJECTED','SUSPENDED'].includes(body.status)) throw new ApiError(400,'Choose APPROVED, REJECTED or SUSPENDED.');
        const note=required(body.note,'Review reason',1000);
        const event=audit('shop',shop.id,'SHOP_REVIEW',{from:shop.status,to:body.status,note},'EXISTS (SELECT 1 FROM shops WHERE id=? AND revision=?)',[shop.id,revision]);
        const results=await env.DB.batch([event.statement,
          env.DB.prepare('UPDATE shops SET status=?,approval_note=?,revision=revision+1 WHERE id=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)').bind(body.status,note,shop.id,event.id)]);
        if(!results[0].meta.changes) throw new ApiError(409,'Shop changed. Refresh before reviewing.');
        return json({ok:true});
      }
      if(request.method==='PATCH' && shopMatch[2]==='plan') {
        const body=await bodyJson(request); const revision=version(body);
        const plan=await env.DB.prepare('SELECT * FROM plans WHERE id=? AND published=1').bind(required(body.plan_id,'Plan',40)).first();
        if(!plan) throw new ApiError(400,'Choose a published plan.');
        const expires=plan.id==='free' ? null : body.expires_at;
        if(plan.id!=='free' && (!Number.isSafeInteger(expires) || expires<=now() || expires>now()+366*86400)) throw new ApiError(400,'Paid access requires an expiry within the next year.');
        const note=required(body.note,'Payment reference or grant reason',1000);
        const event=audit('shop',shop.id,'PLAN_CHANGED',{from:shop.plan_id,to:plan.id,expires_at:expires,note,quoted_monthly_price_minor:plan.monthly_price_minor,currency:plan.currency},'EXISTS (SELECT 1 FROM shops WHERE id=? AND revision=?)',[shop.id,revision]);
        const results=await env.DB.batch([event.statement,env.DB.prepare('UPDATE shops SET plan_id=?,plan_expires_at=?,revision=revision+1 WHERE id=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)').bind(plan.id,expires,shop.id,event.id)]);
        if(!results[0].meta.changes) throw new ApiError(409,'Shop changed. Refresh before assigning a plan.');
        return json({ok:true});
      }
    }
    if(path==='/admin/plans' && request.method==='GET') return json({plans:(await env.DB.prepare('SELECT * FROM plans ORDER BY product_limit').all()).results});
    const planMatch=path.match(/^\/admin\/plans\/([a-z0-9_-]+)$/);
    if(planMatch && request.method==='PATCH') {
      const body=await bodyJson(request); const revision=version(body);
      if(planMatch[1]==='free') throw new ApiError(400,'The Free plan is fixed at 10 products and zero cost.');
      const name=required(body.name,'Plan name',80);
      if(!Number.isSafeInteger(body.product_limit) || body.product_limit<11 || body.product_limit>100000) throw new ApiError(400,'Paid plan limit must be 11–100000 products.');
      if(!Number.isSafeInteger(body.monthly_price_minor) || body.monthly_price_minor<=0 || body.monthly_price_minor>999999999) throw new ApiError(400,'Set a positive monthly price in minor currency units.');
      if(!['USD','EUR','GBP','AED','TRY','IRR'].includes(body.currency) || typeof body.published!=='boolean') throw new ApiError(400,'Invalid currency or publication setting.');
      const plan=await env.DB.prepare('SELECT * FROM plans WHERE id=?').bind(planMatch[1]).first();
      if(!plan) throw new ApiError(404,'Plan not found.');
      const detail={name,product_limit:body.product_limit,monthly_price_minor:body.monthly_price_minor,currency:body.currency,published:body.published};
      const event=audit('plan',plan.id,'PLAN_UPDATED',detail,'EXISTS (SELECT 1 FROM plans WHERE id=? AND revision=?)',[plan.id,revision]);
      const result=await env.DB.batch([event.statement,env.DB.prepare('UPDATE plans SET name=?,product_limit=?,monthly_price_minor=?,currency=?,published=?,revision=revision+1 WHERE id=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)').bind(name,body.product_limit,body.monthly_price_minor,body.currency,body.published?1:0,plan.id,event.id)]);
      if(!result[0].meta.changes) throw new ApiError(409,'Plan changed. Refresh before saving.');
      return json({ok:true});
    }
    if(path==='/admin/orders' && request.method==='GET') {
      const shopId=url.searchParams.get('shop_id') || ''; const query=optional(url.searchParams.get('q') || '','Search',100);
      return json({orders:(await env.DB.prepare(`SELECT o.*,s.name AS shop_name,c.name AS customer_name,c.phone AS customer_phone,
        (SELECT count(*) FROM notifications n WHERE n.order_id=o.id AND n.state='FAILED') AS failed_notifications
        FROM marketplace_orders o JOIN shops s ON s.id=o.shop_id JOIN customers c ON c.id=o.customer_id
        WHERE (?='' OR o.shop_id=?) AND (?='' OR o.id=? OR instr(lower(c.name),lower(?))>0 OR instr(c.phone,?)>0)
        ORDER BY o.created_at DESC,o.id LIMIT 50 OFFSET ?`).bind(shopId,shopId,query,query,query,query,pageOffset(url)).all()).results});
    }
    const retryMatch=path.match(/^\/admin\/orders\/([^/]+)\/retry-notifications$/);
    if(retryMatch && request.method==='POST') {
      const body=await bodyJson(request); const note=required(body.note,'Retry reason',500);
      const event=audit('order',retryMatch[1],'NOTIFICATIONS_REQUEUED',{note},"EXISTS (SELECT 1 FROM notifications WHERE order_id=? AND state='FAILED')",[retryMatch[1]]);
      const results=await env.DB.batch([event.statement,env.DB.prepare("UPDATE notifications SET state='PENDING',attempts=0,next_attempt=0,error_code=NULL WHERE order_id=? AND state='FAILED' AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)").bind(retryMatch[1],event.id)]);
      return json({requeued:results[1].meta.changes});
    }
    if(path==='/admin/customers' && request.method==='GET') {
      const query=optional(url.searchParams.get('q') || '','Search',100);
      return json({customers:(await env.DB.prepare(`SELECT c.id,c.name,c.phone,c.verified_at,
        (SELECT count(*) FROM shops WHERE owner_id=c.id) AS shop_count,
        (SELECT count(*) FROM marketplace_orders WHERE customer_id=c.id) AS order_count
        FROM customers c WHERE ?='' OR instr(lower(c.name),lower(?))>0 OR instr(c.phone,?)>0
        ORDER BY c.verified_at DESC,c.id LIMIT 50 OFFSET ?`).bind(query,query,query,pageOffset(url)).all()).results});
    }
    throw new ApiError(404,'Not found.');
  }
  const seller=path.match(/^\/merchant\/([^/]+)\/(categories|customers|usage)(?:\/([^/]+))?$/);
  if(seller) {
    const shop=await ownedShop(env,seller[1],user); const section=seller[2]; const resource=seller[3];
    if(section==='usage' && request.method==='GET') return json({shop,usage:await shopUsage(env,shop.id)});
    if(section==='customers' && request.method==='GET') {
      const query=optional(url.searchParams.get('q') || '','Search',100);
      return json({customers:(await env.DB.prepare(`SELECT c.id,c.name,c.phone,count(o.id) AS order_count,
        sum(CASE WHEN o.status='ACCEPTED' THEN o.quantity*o.unit_price_minor ELSE 0 END) AS approved_total_minor,
        max(o.created_at) AS last_order_at FROM marketplace_orders o JOIN customers c ON c.id=o.customer_id
        WHERE o.shop_id=? AND (?='' OR instr(lower(c.name),lower(?))>0 OR instr(c.phone,?)>0)
        GROUP BY c.id ORDER BY last_order_at DESC,c.id LIMIT 50 OFFSET ?`).bind(shop.id,query,query,query,pageOffset(url)).all()).results,currency:shop.currency});
    }
    if(section==='categories' && request.method==='GET') return json({categories:(await env.DB.prepare('SELECT * FROM categories WHERE shop_id=? ORDER BY name LIMIT 100').bind(shop.id).all()).results});
    if(shop.status==='SUSPENDED') throw new ApiError(403,'Suspended shops cannot change their catalog. Contact support.');
    if(section==='categories' && request.method==='POST' && !resource) {
      const body=await bodyJson(request); const name=required(body.name,'Category name',80); const categoryId=uuid();
      const result=await env.DB.prepare('INSERT INTO categories (id,shop_id,name) SELECT ?,?,? WHERE (SELECT count(*) FROM categories WHERE shop_id=?)<100').bind(categoryId,shop.id,name,shop.id).run();
      if(!result.meta.changes) throw new ApiError(409,'Maximum 100 categories per shop.');
      return json({id:categoryId},201);
    }
    if(section==='categories' && resource && request.method==='PATCH') {
      const body=await bodyJson(request); const result=await env.DB.prepare('UPDATE categories SET name=? WHERE id=? AND shop_id=?').bind(required(body.name,'Category name',80),resource,shop.id).run();
      if(!result.meta.changes) throw new ApiError(404,'Category not found.'); return json({ok:true});
    }
    if(section==='categories' && resource && request.method==='DELETE') {
      const category=await env.DB.prepare('SELECT id FROM categories WHERE id=? AND shop_id=?').bind(resource,shop.id).first();
      if(!category) throw new ApiError(404,'Category not found.');
      await env.DB.batch([env.DB.prepare('UPDATE products SET category_id=NULL WHERE category_id=? AND shop_id=?').bind(resource,shop.id),env.DB.prepare('DELETE FROM categories WHERE id=? AND shop_id=?').bind(resource,shop.id)]);
      return json({ok:true});
    }
    throw new ApiError(404,'Not found.');
  }
  // Private platform tickets never become visible to the other party to an order.
  const visibility=`(t.requester_id=? OR ?=1 OR (t.audience='SHOP' AND (s.owner_id=? OR o.customer_id=?)))`;
  const visibilityArgs=[user.id,admin?1:0,user.id,user.id];
  const ticketFrom='FROM support_tickets t LEFT JOIN shops s ON s.id=t.shop_id LEFT JOIN marketplace_orders o ON o.id=t.order_id';
  if(path==='/support' && request.method==='GET') {
    const status=url.searchParams.get('status') || '';
    if(status && !['OPEN','WAITING','RESOLVED'].includes(status)) throw new ApiError(400,'Invalid ticket status.');
    return json({tickets:(await env.DB.prepare(`SELECT t.*,s.name AS shop_name ${ticketFrom} WHERE ${visibility} AND (?='' OR t.status=?) ORDER BY t.updated_at DESC,t.id LIMIT 50 OFFSET ?`).bind(...visibilityArgs,status,status,pageOffset(url)).all()).results});
  }
  if(path==='/support' && request.method==='POST') {
    const body=await bodyJson(request); const subject=required(body.subject,'Subject',120); const message=required(body.message,'Message',2000);
    let shopId=null,orderId=null; const audience=body.audience || 'PLATFORM';
    if(!['SHOP','PLATFORM'].includes(audience)) throw new ApiError(400,'Choose SHOP or PLATFORM support.');
    if(body.order_id) {
      const order=await env.DB.prepare('SELECT o.*,s.owner_id FROM marketplace_orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=?').bind(required(body.order_id,'Order ID',80)).first();
      if(!order || (!admin && order.customer_id!==user.id && order.owner_id!==user.id)) throw new ApiError(404,'Order not found.');
      shopId=order.shop_id; orderId=order.id;
    } else if(body.shop_id) {
      const shop=await env.DB.prepare('SELECT id,owner_id FROM shops WHERE id=?').bind(required(body.shop_id,'Shop ID',80)).first();
      if(!shop || (!admin && shop.owner_id!==user.id)) throw new ApiError(404,'Shop not found.'); shopId=shop.id;
    }
    if(audience==='SHOP' && !orderId) throw new ApiError(400,'Shared shop support requires an order.');
    let requesterId=user.id;
    if(body.requester_id && body.requester_id!==user.id) {
      if(!admin) throw new ApiError(403,'Only platform support can open a ticket for another account.');
      const target=await env.DB.prepare('SELECT id FROM customers WHERE id=?').bind(required(body.requester_id,'Requester',80)).first();
      if(!target) throw new ApiError(404,'Requester not found.');
      if(orderId) {
        const order=await env.DB.prepare('SELECT o.customer_id,s.owner_id FROM marketplace_orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=?').bind(orderId).first();
        if(target.id!==order.customer_id && target.id!==order.owner_id) throw new ApiError(400,'Requester must belong to this order.');
      } else if(shopId) {
        const shop=await env.DB.prepare('SELECT owner_id FROM shops WHERE id=?').bind(shopId).first();
        if(target.id!==shop.owner_id) throw new ApiError(400,'Requester must own this shop.');
      }
      requesterId=target.id;
    }
    const ticketId=uuid(); const timestamp=now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO support_tickets (id,requester_id,shop_id,order_id,audience,subject,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(ticketId,requesterId,shopId,orderId,audience,subject,timestamp,timestamp),
      env.DB.prepare('INSERT INTO support_messages (id,ticket_id,author_id,body,created_at) VALUES (?,?,?,?,?)').bind(uuid(),ticketId,user.id,message,timestamp)
    ]);
    return json({id:ticketId},201);
  }
  const ticketMatch=path.match(/^\/support\/([^/]+)(?:\/(messages))?$/);
  if(ticketMatch) {
    const ticket=await env.DB.prepare(`SELECT t.* ${ticketFrom} WHERE t.id=? AND ${visibility}`).bind(ticketMatch[1],...visibilityArgs).first();
    if(!ticket) throw new ApiError(404,'Ticket not found.');
    if(!ticketMatch[2] && request.method==='GET') return json({ticket,messages:(await env.DB.prepare('SELECT m.id,m.body,m.created_at,c.name AS author_name,m.author_id FROM support_messages m JOIN customers c ON c.id=m.author_id WHERE m.ticket_id=? ORDER BY m.rowid DESC LIMIT 50 OFFSET ?').bind(ticket.id,pageOffset(url)).all()).results});
    if(ticketMatch[2]==='messages' && request.method==='POST') {
      const body=await bodyJson(request); const messageId=uuid();
      const results=await env.DB.batch([
        env.DB.prepare("INSERT INTO support_messages (id,ticket_id,author_id,body,created_at) SELECT ?,id,?,?,? FROM support_tickets WHERE id=? AND status<>'RESOLVED'").bind(messageId,user.id,required(body.message,'Message',2000),now(),ticket.id),
        env.DB.prepare('UPDATE support_tickets SET updated_at=?,revision=revision+1 WHERE id=? AND EXISTS (SELECT 1 FROM support_messages WHERE id=?)').bind(now(),ticket.id,messageId)
      ]);
      if(!results[0].meta.changes) throw new ApiError(409,'Reopen the resolved ticket before replying.');
      return json({ok:true},201);
    }
    if(!ticketMatch[2] && request.method==='PATCH') {
      const body=await bodyJson(request); const revision=version(body);
      if(!admin && user.id!==ticket.requester_id) throw new ApiError(403,'Only the requester or platform support can change ticket status.');
      if(!['OPEN','RESOLVED',...(admin?['WAITING']:[])].includes(body.status)) throw new ApiError(400,'Invalid ticket status.');
      const event=audit('ticket',ticket.id,'TICKET_STATUS',{from:ticket.status,to:body.status},'EXISTS (SELECT 1 FROM support_tickets WHERE id=? AND revision=?)',[ticket.id,revision]);
      const results=await env.DB.batch([event.statement,env.DB.prepare('UPDATE support_tickets SET status=?,updated_at=?,revision=revision+1 WHERE id=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)').bind(body.status,now(),ticket.id,event.id)]);
      if(!results[0].meta.changes) throw new ApiError(409,'Ticket changed. Refresh before updating.'); return json({ok:true});
    }
  }
  throw new ApiError(404,'Not found.');
}
