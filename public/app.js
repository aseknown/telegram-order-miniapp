import { createManagementUI } from './dashboard.js';
import { createRequestScope } from './request-client.js';

const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
const $ = id => document.getElementById(id);
const state = {config:null,me:null,shop:null,token:null};
const requestScope=createRequestScope();
const telegramProof=tg?.initData || '';
const route = location.pathname.replace(/^\/+|\/+$/g,'');
const isMerchant = route === 'merchant';
const isDashboard=['merchant','admin','support','pricing','security','stores'].includes(route);
document.body.dataset.surface=(!route || route==='stores' || !isDashboard) ? 'market' : 'workspace';
const dashboards=createManagementUI({api,text,append,button,link,field,formSubmit,pager,money,state,content:()=>$('content'),orderCard,
  heading:(title,description)=>{document.body.dataset.surface='workspace'; $('heading').textContent=title; $('intro').textContent=description;}});
function text(tag,value='',className='') { const el=document.createElement(tag); el.textContent=value; el.className=className; return el; }
function append(parent,...children) { parent.append(...children); return parent; }
function button(label,fn,className='secondary') {
  const el=text('button',label,className); el.type='button';
  el.addEventListener('click',()=>run(async()=>{el.disabled=true; el.setAttribute('aria-busy','true'); try {await fn();} finally {el.disabled=false; el.removeAttribute('aria-busy');}})); return el;
}
function link(label,url) {const el=text('a',label,'store-link'); el.href=url; return el;}
async function run(fn) {
  const generation=requestScope.begin(); $('alert').classList.add('hidden'); document.body.classList.add('is-working');
  try {await fn();} catch(e) {if(e.name==='AbortError') return; $('alert').textContent=e.message || 'Something went wrong.'; $('alert').classList.remove('hidden'); window.scrollTo({top:0,behavior:'smooth'});}
  finally {if(requestScope.current(generation)) document.body.classList.remove('is-working');}
}
function clearIdentity() {state.token=null; state.me=null; $('history').replaceChildren(); $('content').replaceChildren(); $('accountActions').replaceChildren(); $('accountName').textContent='Session ended'; $('accountHint').textContent='Close and reopen this app in Telegram to sign in securely.';}
let toastTimer;
function toast(message) {const el=$('toast'); el.textContent=message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('visible'),3000);}
async function api(path,options={}) {
  const scope=requestScope.capture();
  if((tg?.initData || '')!==telegramProof) {clearIdentity(); throw new Error('Telegram account changed. Reopen the app to continue.');}
  const headers=new Headers(options.headers);
  if(state.token) headers.set('authorization','Bearer '+state.token);
  if(options.body && !(options.body instanceof FormData)) {headers.set('content-type','application/json'); options.body=JSON.stringify(options.body);}
  const res=await fetch('/api/v1'+path,{...options,headers,signal:(!options.method || options.method==='GET')?scope.signal:undefined}); const data=await res.json().catch(()=>({}));
  scope.assertCurrent();
  if(res.status===401) clearIdentity();
  if(!res.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function money(value,currency) {return `${(value/100).toFixed(2)} ${currency}`;}
function signedIn() {if(!state.me?.customer) throw new Error('Verify your phone with the bot and refresh your account first.');}
function openBot() {
  const username=state.config?.botUsername;
  if(!/^[a-zA-Z0-9_]{5,32}$/.test(username || '')) throw new Error('The platform operator needs to configure the bot username.');
  const url=`https://t.me/${username}?start=${encodeURIComponent(!isDashboard && route ? route : 'marketplace')}`;
  if(tg?.initData && tg.requestContact) tg.requestContact(()=>run(refreshAccount));
  else if(tg?.openTelegramLink) tg.openTelegramLink(url);
  else location.href=url;
}
async function refreshAccount() {
  if(telegramProof && !state.token) {
    const scope=requestScope.capture();
    const response=await fetch('/api/v1/auth/session',{method:'POST',headers:{authorization:'Telegram '+telegramProof},signal:scope.signal}); const data=await response.json(); scope.assertCurrent();
    if(!response.ok) throw new Error(data.error || 'Could not sign in.');
    state.token=data.token || null;
  }
  if(state.token) state.me=await api('/me');
  const user=state.me?.customer;
  $('accountName').textContent=user ? `${user.name} · ${user.phone}` : 'One phone. Every shop.';
  $('accountHint').textContent=user ? 'Your account works across every store.' : 'Share your own phone with the bot, then refresh your account.';
  const actions=$('accountActions'); actions.replaceChildren();
  if(!user) actions.append(button(tg?.initData ? 'Share phone' : 'Open in Telegram',openBot));
  if(tg?.initData) actions.append(button('Refresh account',refreshAccount));
  if(user) actions.append(button('My orders',()=>history()),button('Support',()=>dashboards.supportDashboard()));
  if(state.me?.isSuperAdmin) actions.append(button('Platform admin',()=>dashboards.adminDashboard()));
  if(user) actions.append(button('Sessions',()=>sessionPage()));
  if(isMerchant) renderShops();
}
function pager(container,page,count,load) {
  const row=text('div','','actions'); const prev=button('← Previous',()=>load(page-1)); prev.disabled=page===1;
  const next=button('Next →',()=>load(page+1)); next.disabled=count<50;
  append(container,append(row,prev,text('span',`Page ${page}`),next));
}
async function catalog(page=1) {
  document.body.dataset.surface=(!route || route==='stores' || !isDashboard)?'market':'workspace';
  if(route==='security') return sessionPage();
  if(route==='pricing') return dashboards.pricingPage();
  if(route==='admin' || route==='support') {
    if(!state.me?.customer) {$('heading').textContent=route==='admin' ? 'Platform administration' : 'Support'; $('intro').textContent='Sign in with your verified account to continue.'; return;}
    return route==='admin' ? dashboards.adminDashboard() : dashboards.supportDashboard();
  }
  if(isMerchant) { $('heading').textContent='Your store starts here.'; $('intro').textContent='Create your profile, add products, and share one link with your customers.'; return renderShops(); }
  const params=new URLSearchParams(location.search); params.set('page',String(page));
  const data=await api(route==='stores' ? `/shops?${params}` : route ? `/shops/${encodeURIComponent(route)}?${params}` : `/catalog?${params}`);
  const content=$('content'); content.replaceChildren(); const grid=text('div','','grid'); content.append(grid);
  if(route!=='stores') {
    content.prepend(catalogFilters(data,params));
    if(!route) {$('heading').textContent='Good finds. Independent minds.'; $('intro').textContent='Discover products from independent shops. Pay your seller directly and track every order in one place.';}
    else {
    state.shop=data.shop; $('heading').textContent=data.shop.name; $('intro').textContent=data.shop.description || 'Browse our products and order directly.'; document.title=data.shop.name+' · Shopline';
    }
    for(const p of data.products) {
      const art=append(text('div','','product-art'),text('span',p.name.slice(0,1).toUpperCase(),'product-initial'),text('span',p.category_name || 'INDEPENDENT FIND','art-label'));
      art.dataset.tone=String([...p.id].reduce((sum,c)=>sum+c.charCodeAt(0),0)%4);
      grid.append(append(text('article','','card product-card'),art,text('div',p.shop_name,'eyebrow'),text('h3',p.name),text('p',p.description || 'Available directly from this store.','muted'),text('div',money(p.price_minor,p.currency),'price'),button('View & order →',async()=>{state.shop=(await api('/shops/'+p.shop_slug)).shop; checkout(p);},'primary'),link('Visit '+p.shop_name,'/'+p.shop_slug)));
    }
  } else {
    $('heading').textContent='Meet the independent shops.'; $('intro').textContent='Explore approved stores, each with their own story and collection.';
    for(const shop of data.shops) grid.append(append(text('article','','card'),text('div','INDEPENDENT STORE','eyebrow'),text('h3',shop.name),text('p',shop.description,'muted'),link('Visit store ↗','/'+shop.slug)));
  }
  const count=(data.products || data.shops).length;
  if(!count) grid.append(append(text('div','','empty-state'),text('span','↗','empty-icon'),text('h3','Nothing here just yet'),text('p',route==='stores'?'New stores will appear here after approval.':'Try another filter, or explore individual stores for more products.','muted'),link('Explore stores','/stores'))); pager(content,page,count,catalog);
}
function catalogFilters(data,params) {
  const form=text('form','','catalog-filters');
  const search=field(form,'q','Find something you’ll love',params.get('q') || '',{maxLength:100,placeholder:'Search products…'}); search.parentElement.classList.add('filter-search');
  dashboards.selectId(form,'category','Category',[{id:'',name:'All categories'},...(data.categories || []).map(c=>({id:c.id,name:route?c.name:`${c.name} · ${c.shop_name}`}))],params.get('category') || '');
  if(!route) {
    dashboards.selectId(form,'currency','Currency',[{id:'',name:'All currencies'},...['USD','EUR','GBP','AED','TRY','IRR'].map(id=>({id,name:id}))],params.get('currency') || '');
    field(form,'seller','Store username',params.get('seller') || '',{maxLength:40,placeholder:'Any store'});
  }
  field(form,'min','Min price',params.get('min') || '',{type:'number',min:0,step:0.01});
  field(form,'max','Max price',params.get('max') || '',{type:'number',min:0,step:0.01});
  dashboards.selectId(form,'sort','Sort by',[{id:'newest',name:'Newest first'},{id:'name',name:'Name A–Z'},{id:'price_asc',name:'Price: low to high'},{id:'price_desc',name:'Price: high to low'}],params.get('sort') || 'newest');
  formSubmit(form,'Apply filters',async()=>{const query=new URLSearchParams(); for(const [key,value] of new FormData(form)) if(value) query.set(key,value); window.history.replaceState(null,'',location.pathname+(query.size?'?'+query:'')); await catalog();});
  form.append(button('Reset',async()=>{window.history.replaceState(null,'',location.pathname); await catalog();},'back'),text('p',`${data.total} products`,'results-count'));
  return form;
}
async function sessionPage() {
  signedIn(); const data=await api('/sessions'); $('heading').textContent='Your account, your access.'; $('intro').textContent='Sessions are separate from shop permissions. Ending one immediately blocks its next request.'; $('content').replaceChildren();
  for(const session of data.sessions) $('content').append(append(text('article','','panel'),text('h3',session.id===data.currentSessionId?'This session':'Telegram session'),text('p',session.label,'hint'),text('p','Expires '+new Date(session.expires_at*1000).toLocaleString()),button('End session',async()=>{await api('/sessions/'+session.id,{method:'DELETE'}); if(session.id===data.currentSessionId) {clearIdentity(); toast('Session ended');} else await sessionPage();})));
  $('content').append(button('End all sessions',async()=>{await api('/sessions/all',{method:'DELETE'}); clearIdentity(); toast('All sessions ended');}));
}
function field(form,name,label,value='',options={}) {
  const wrapper=text('label',label); const input=document.createElement(options.area ? 'textarea' : options.select ? 'select' : 'input'); input.name=name;
  if(options.select) for(const choice of options.select) input.append(text('option',choice));
  else if(!options.area) input.type=options.type || 'text';
  for(const [key,val] of Object.entries(options)) if(!['area','select'].includes(key)) input[key]=val;
  if(options.type==='checkbox') input.checked=Boolean(value); else input.value=value;
  wrapper.append(input); form.append(wrapper); return input;
}
function formSubmit(form,label,fn) {
  const submit=text('button',label,'primary'); submit.type='submit'; form.append(submit);
  form.addEventListener('submit',event=>{event.preventDefault(); run(async()=>{submit.disabled=true; submit.setAttribute('aria-busy','true'); try {await fn();} finally {submit.disabled=false; submit.removeAttribute('aria-busy');}});});
}
function checkout(product) {
  if(!state.config.checkoutAvailable) throw new Error('Ordering is temporarily unavailable. The platform operator needs to finish the bot setup.');
  const shop=state.shop; let requestKey=crypto.randomUUID(); const form=text('form','','panel');
  const summary=text('p','','summary');
  append(form,button('← Products',()=>catalog(),'back'),text('h2','Complete your order'),summary);
  const qty=field(form,'quantity','Quantity','1',{type:'number',min:1,max:20,step:1,required:true});
  const updateSummary=()=>summary.textContent=`${product.name} × ${qty.value} · ${money(product.price_minor*Number(qty.value),shop.currency)}`;
  qty.addEventListener('input',updateSummary); updateSummary();
  form.append(append(text('div','','payment'),text('div','PAY THE STORE DIRECTLY','eyebrow'),text('h3',shop.payment_number),text('p',shop.payment_holder),text('p',shop.payment_note),button('Copy number',()=>navigator.clipboard.writeText(shop.payment_number))));
  const files=field(form,'attachments','Payment receipt and attachments','',{type:'file',accept:'image/jpeg,image/png,image/webp',multiple:true,required:true});
  form.append(text('p','1–3 JPG, PNG or WebP images. Up to 1 MB each.','hint'));
  field(form,'note','Note to the shop','',{area:true,maxLength:500});
  form.addEventListener('input',()=>{requestKey=crypto.randomUUID();});
  formSubmit(form,'Submit order',async()=>{
    signedIn(); const selected=[...files.files];
    if(!selected.length || selected.length>3 || selected.some(f=>f.size>1048576)) throw new Error('Attach 1–3 images up to 1 MB each.');
    const body=new FormData(form); body.append('shopId',shop.id); body.append('productId',product.id);
    const data=await api('/orders',{method:'POST',body,headers:{'idempotency-key':requestKey}});
    await catalog(); await history(); toast('Order saved. Your seller will review the payment.');
  });
  form.append(text('p','Your contact details and attachments are shared with this shop. The seller verifies your bank transfer before approving the order.','hint'));
    $('content').replaceChildren(form);
}
function renderShops() {
  document.body.dataset.surface='workspace';
  const content=$('content'); content.replaceChildren(); content.append(append(text('div','','section-heading'),text('h2','Your stores'),button('+ Create a store',()=>shopForm())));
  const grid=text('div','','grid'); content.append(grid);
  for(const shop of state.me?.shops || []) grid.append(append(text('article','','card'),text('div',shop.status,'eyebrow'),text('h3',shop.name),link('/'+shop.slug,'/'+shop.slug),button('Manage store',()=>manage(shop))));
}
function shopForm(shop=null) {
  signedIn(); const form=text('form','','panel'); form.append(text('h2',shop ? 'Edit store' : 'Create your store'));
  field(form,'name','Store name',shop?.name || '',{required:true,maxLength:80});
  if(!shop) field(form,'slug','Store username (appdomain/your-username)','',{required:true,pattern:'[a-z0-9][a-z0-9_-]{2,39}',maxLength:40});
  field(form,'description','About your store',shop?.description || '',{area:true,maxLength:1000});
  if(!shop) field(form,'currency','Currency','USD',{select:['USD','EUR','GBP','AED','TRY','IRR']});
  field(form,'payment_number','Card / account / IBAN number',shop?.payment_number || '',{required:true,maxLength:34});
  field(form,'payment_holder','Account holder',shop?.payment_holder || '',{required:true,maxLength:100});
  field(form,'payment_note','Payment instructions',shop?.payment_note || '',{area:true,maxLength:500});
  formSubmit(form,'Save store',async()=>{
    const body=Object.fromEntries(new FormData(form)); if(shop) {body.currency=shop.currency; body.revision=shop.revision;}
    const saved=await api(shop ? '/merchant/'+shop.id : '/shops',{method:shop ? 'PATCH' : 'POST',body});
    await refreshAccount(); await manage(state.me.shops.find(s=>s.id===(shop?.id || saved.id)));
  }); form.append(text('p','Profile changes require approval before the store is published.','hint'),button('Cancel',renderShops,'back')); $('content').replaceChildren(form);
}
async function manage(shop) {
  document.body.dataset.surface='workspace';
  shop=(await api(`/merchant/${shop.id}/usage`)).shop;
  const content=$('content'); content.replaceChildren();
  content.append(button('← Your stores',renderShops,'back'),append(text('div','','section-heading'),text('h2',shop.name),button('Edit profile',()=>shopForm(shop))),link(location.origin+'/'+shop.slug,'/'+shop.slug));
  const integration=text('section','','panel'); const details=text('pre');
  append(integration,text('h3','Connect WooCommerce'),text('p','Install the Shopline Connector plugin in WordPress. Paste the endpoint and store token into its settings to sync simple products automatically.','muted'),button('Generate / rotate token',async()=>{const data=await api(`/merchant/${shop.id}/integration`,{method:'POST'}); details.textContent=`Endpoint: ${data.endpoint}\nToken (shown once): ${data.token}\nGenerating another token revokes the previous one.`;}),button('Disconnect',async()=>{await api(`/merchant/${shop.id}/integration`,{method:'DELETE'}); details.textContent='Connection revoked.';}),details);
  content.append(integration);
  const productFormSlot=text('section'); const productList=text('section'); const orders=text('section');
  let categories=(await api(`/merchant/${shop.id}/categories`)).categories;
  content.append(productFormSlot,productList,orders);
  const loadProducts=async(page=1)=>{
    const {products}=await api(`/merchant/${shop.id}/products?page=${page}`); productList.replaceChildren(text('h3','Products')); const grid=text('div','','grid'); productList.append(grid);
    for(const p of products) {
      const card=append(text('article','','card'),text('h3',p.name),text('p',`${money(p.price_minor,shop.currency)} · ${p.active ? 'Available' : 'Hidden'}${p.source_id ? ' · WooCommerce' : ''}`));
      if(p.archived) card.append(text('p','Archived: does not count toward plan limit.','hint'));
      if(!p.source_id) {
        card.append(button(p.archived?'Edit & restore':'Edit',()=>editProduct(p)));
        if(!p.archived) card.append(button('Archive',async()=>{await api(`/merchant/${shop.id}/products/${p.id}`,{method:'DELETE'}); await manage(shop);}));
      } else {
        const categoryForm=text('form'); dashboards.selectId(categoryForm,'category_id','Category',[{id:'',name:'Uncategorized'},...categories],p.category_id || '');
        const publicFlag=field(categoryForm,'isPublic','Show in the public marketplace',p.is_public,{type:'checkbox'});
        formSubmit(categoryForm,'Save placement',async()=>{const body=Object.fromEntries(new FormData(categoryForm)); body.isPublic=publicFlag.checked; await api(`/merchant/${shop.id}/products/${p.id}`,{method:'PATCH',body}); await loadProducts(page);}); card.append(categoryForm);
      }
      grid.append(card);
    } pager(productList,page,products.length,loadProducts);
  };
  const editProduct=(product=null)=>{
    const form=text('form','','panel'); form.append(text('h3',product ? 'Edit product' : 'Add a product'));
    field(form,'name','Name',product?.name || '',{required:true,maxLength:120});
    field(form,'description','Description',product?.description || '',{area:true,maxLength:1000});
    field(form,'price','Price',product ? (product.price_minor/100).toFixed(2) : '',{type:'number',min:0,max:9999999.99,step:0.01,required:true});
    const active=field(form,'active','Available for orders',product ? product.active : true,{type:'checkbox'});
    const publicFlag=field(form,'isPublic','Also show in the public marketplace',product?.is_public || false,{type:'checkbox'});
    dashboards.selectId(form,'category_id','Category',[{id:'',name:'Uncategorized'},...categories],product?.category_id || '');
    formSubmit(form,'Save product',async()=>{const body=Object.fromEntries(new FormData(form)); body.active=active.checked; body.isPublic=publicFlag.checked; await api(`/merchant/${shop.id}/products${product ? '/'+product.id : ''}`,{method:product ? 'PATCH' : 'POST',body}); await manage(shop);});
    if(product) form.append(button('Cancel edit',()=>editProduct(),'back')); productFormSlot.replaceChildren(form);
  };
  const loadOrders=async(page=1)=>{
    const data=await api(`/merchant/${shop.id}/orders?page=${page}`); orders.replaceChildren(append(text('div','','section-heading'),text('h3','Incoming orders'),button('Refresh',()=>loadOrders(page))));
    for(const order of data.orders) orders.append(orderCard(order,shop,()=>loadOrders(page)));
    if(!data.orders.length) orders.append(text('p','No orders on this page.','muted')); pager(orders,page,data.orders.length,loadOrders);
  };
  const sellerPanel=text('section'); content.insertBefore(sellerPanel,integration);
  await dashboards.sellerTools(shop,sellerPanel,async()=>{categories=(await api(`/merchant/${shop.id}/categories`)).categories; editProduct(); await loadProducts();});
  editProduct(); await loadProducts(); await loadOrders();
}
function orderCard(order,shop=null,refresh=null) {
  const card=append(text('article','','panel'),text('div',order.status.replaceAll('_',' '),'eyebrow'),text('h3',`${order.product_name} × ${order.quantity}`),text('p',money(order.unit_price_minor*order.quantity,order.currency)),text('p','Order '+order.id,'hint'));
  if(shop) append(card,text('p',`${order.customer_name} · ${order.customer_phone}`),text('p',order.customer_note));
  if(order.failed_notifications) card.append(text('p','Telegram delivery needs attention. The order and receipts are saved here.','alert'));
  if(order.delivery_link && order.status==='ACCEPTED') card.append(link('Your product link ↗',order.delivery_link));
  const actions=text('div','','actions'); const receipts=text('div','','actions');
  actions.append(button('Order support',()=>dashboards.ticketForm({order_id:order.id,requester_id:state.me?.isSuperAdmin ? order.customer_id : undefined,audience:'SHOP',subject:'Help with order '+order.id})));
  actions.append(button('View receipts',async()=>{
    const data=await api(`/orders/${order.id}/attachments`); receipts.replaceChildren();
    for(const file of data.attachments) receipts.append(button('Download receipt',async()=>{
      const scope=requestScope.capture();
      const response=await fetch(`/api/v1/orders/${order.id}/attachments/${file.id}`,{headers:{authorization:'Bearer '+state.token},signal:scope.signal}); scope.assertCurrent();
      if(!response.ok) throw new Error('Could not load receipt.');
      const url=URL.createObjectURL(await response.blob()); const a=link('Download',url); a.download=`receipt-${file.id}.${({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'})[file.mime]}`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),30000);
    }));
  }));
  if(shop && order.status==='WAITING_REVIEW') {
    const delivery=field(card,'delivery_link','Product delivery link (optional)','',{type:'url',maxLength:1000,placeholder:'https://...'});
    for(const [label,status] of [['Approve payment','ACCEPTED'],['Reject payment','REJECTED']]) actions.append(button(label,async()=>{await api(`/merchant/${shop.id}/orders/${order.id}`,{method:'PATCH',body:{status,delivery_link:delivery.value}}); await refresh();}));
  }
  return append(card,actions,receipts);
}
async function history(page=1) {
  signedIn(); const {orders}=await api(`/orders?page=${page}`); $('history').classList.remove('hidden'); $('historyList').replaceChildren(...orders.map(o=>orderCard(o)));
  if(!orders.length) $('historyList').append(text('p','No orders on this page.','muted')); pager($('historyList'),page,orders.length,history);
}
run(async()=>{state.config=await api('/config'); let authError; try {await refreshAccount();} catch(error) {authError=error;} await catalog(); if(authError) throw authError;});
