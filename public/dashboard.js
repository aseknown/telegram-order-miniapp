export function createManagementUI(ui) {
  const {api,text,append,button,link,field,formSubmit,pager,money,state,content,orderCard}=ui;
  function heading(title,description) {ui.heading(title,description); content().replaceChildren();}
  function signedIn() {if(!state.me?.customer) throw new Error('Verify your phone and refresh your account first.');}
  function selectId(form,name,label,items,value='') {
    const input=field(form,name,label,'',{select:[]});
    for(const item of items) {const option=text('option',item.name); option.value=item.id; input.append(option);}
    input.value=value || items[0]?.id || ''; return input;
  }
  function search(container,label,load) {
    const form=text('form','','search-form'); const input=field(form,'q',label,'',{maxLength:100});
    formSubmit(form,'Search',()=>load(1,input.value)); container.append(form);
  }
  async function pricingPage(shop=null) {
    heading('Start small. Grow your store.','Free includes 10 products per shop. Every new shop is reviewed before going live.');
    const {plans}=await api('/plans'); const grid=text('section','','grid'); content().append(grid);
    for(const plan of plans) {
      const card=append(text('article','','card'),text('div',plan.name.toUpperCase(),'eyebrow'),text('h2',plan.id==='free' ? 'Free' : money(plan.monthly_price_minor,plan.currency)+' / month'),text('p',`${plan.product_limit} products per shop`),text('p','Store profile, categories, order management, customer list and support.','muted'));
      card.append(plan.id==='free' ? link('Create your store','/merchant') : button('Request this plan',()=>ticketForm({shop_id:shop?.id,subject:`Upgrade request: ${plan.name}`,message:`I would like ${plan.name}: ${plan.product_limit} products, ${money(plan.monthly_price_minor,plan.currency)} per month.`,audience:'PLATFORM'})));
      grid.append(card);
    }
    content().append(text('p','Paid plans are activated by platform support after payment or an agreed grant. There is no automatic charge or renewal.','hint'));
    if(shop) content().append(text('p','The upgrade request is linked to '+shop.name+'.','hint'));
  }
  function ticketForm(initial={}) {
    signedIn(); heading('Contact support','Order conversations can be shared with the seller. Platform-only conversations stay private.');
    const form=text('form','','panel');
    field(form,'subject','Subject',initial.subject || '',{required:true,maxLength:120});
    if(initial.order_id) selectId(form,'audience','Who can see this conversation?',[{id:'SHOP',name:'Customer, seller and platform support'},{id:'PLATFORM',name:'Only me and platform support'}],initial.audience || 'SHOP');
    field(form,'message','How can we help?',initial.message || '',{area:true,required:true,maxLength:2000});
    formSubmit(form,'Create support ticket',async()=>{
      const body=Object.fromEntries(new FormData(form)); body.audience=body.audience || 'PLATFORM';
      if(initial.order_id) body.order_id=initial.order_id;
      if(initial.shop_id) body.shop_id=initial.shop_id;
      if(initial.requester_id) body.requester_id=initial.requester_id;
      const result=await api('/support',{method:'POST',body}); await ticketDetail(result.id);
    }); content().append(form);
  }
  async function supportDashboard(page=1,status='') {
    signedIn(); heading('Support inbox','Track questions, order issues and seller support in one place.');
    const filters=append(text('div','','actions'),button('New ticket',()=>ticketForm()));
    for(const value of ['','OPEN','WAITING','RESOLVED']) filters.append(button(value || 'All',()=>supportDashboard(1,value)));
    content().append(filters);
    const {tickets}=await api(`/support?page=${page}&status=${status}`);
    for(const ticket of tickets) content().append(append(text('article','','panel'),text('div',`${ticket.status} · ${ticket.audience==='SHOP' ? 'Shared order conversation' : 'Private platform support'}`,'eyebrow'),text('h3',ticket.subject),text('p',ticket.shop_name || 'Platform'),button('Open conversation',()=>ticketDetail(ticket.id))));
    if(!tickets.length) content().append(text('p','No tickets in this view.','muted')); pager(content(),page,tickets.length,p=>supportDashboard(p,status));
  }
  async function ticketDetail(id,page=1) {
    const {ticket,messages}=await api(`/support/${id}?page=${page}`);
    heading(ticket.subject,ticket.audience==='SHOP' ? 'Visible to the customer, shop owner and platform support.' : 'Private: requester and platform support only.');
    content().append(button('← Support inbox',()=>supportDashboard(),'back'),text('p',`Status: ${ticket.status}`));
    if(ticket.order_id) content().append(text('p','Order '+ticket.order_id,'hint'));
    const thread=text('section','','stack'); content().append(thread);
    for(const message of [...messages].reverse()) thread.append(append(text('article','','panel'),text('strong',message.author_name),text('p',message.body,'message-body'),text('small',new Date(message.created_at*1000).toLocaleString(),'muted')));
    pager(content(),page,messages.length,p=>ticketDetail(id,p));
    if(ticket.status!=='RESOLVED') {
      const form=text('form','','panel'); field(form,'message','Reply','',{area:true,maxLength:2000,required:true});
      formSubmit(form,'Send reply',async()=>{await api(`/support/${id}/messages`,{method:'POST',body:Object.fromEntries(new FormData(form))}); await ticketDetail(id);}); content().append(form);
    }
    if(state.me.isSuperAdmin || state.me.customer.id===ticket.requester_id) {
      const actions=text('div','','actions');
      for(const status of ['OPEN',...(state.me.isSuperAdmin?['WAITING']:[]),'RESOLVED'].filter(s=>s!==ticket.status)) actions.append(button(status==='RESOLVED'?'Mark resolved':status==='OPEN'?'Reopen':'Waiting for reply',async()=>{await api(`/support/${id}`,{method:'PATCH',body:{status,revision:ticket.revision}}); await ticketDetail(id);}));
      content().append(actions);
    }
  }
  async function adminDashboard(section='shops',page=1,filter='PENDING',query='') {
    signedIn(); if(!state.me.isSuperAdmin) throw new Error('Super admin access required.');
    heading('Platform administration','Review shops, manage plans and help buyers and sellers.');
    const tabs=text('div','','actions');
    for(const [key,label] of [['shops','Shop reviews'],['orders','Orders'],['customers','Customers & sellers'],['plans','Pricing plans']]) tabs.append(button(label,()=>adminDashboard(key)));
    tabs.append(button('Support inbox',()=>supportDashboard())); content().append(tabs);
    if(section==='shops') {
      const stats=await api('/admin/overview');
      const tiles=text('div','','stats-grid');
      for(const [label,key] of [['Pending shops','pending_shops'],['Live shops','approved_shops'],['Orders','orders'],['Open tickets','open_tickets'],['Failed notifications','failed_notifications']]) tiles.append(append(text('div','','card'),text('strong',String(stats[key]),'price'),text('span',label,'muted')));
      content().append(tiles);
      const filters=text('div','','actions'); for(const status of ['PENDING','APPROVED','REJECTED','SUSPENDED','']) filters.append(button(status || 'All shops',()=>adminDashboard('shops',1,status))); content().append(filters);
      const {shops}=await api(`/admin/shops?page=${page}&status=${filter}`);
      const {plans}=await api('/admin/plans');
      for(const shop of shops) {
        const card=append(text('article','','panel'),text('div',shop.status,'eyebrow'),text('h3',shop.name),text('p',`Owner: ${shop.owner_name} · ${shop.owner_phone}`),text('p',shop.description),text('p',`${shop.product_count}/${shop.product_limit} products · ${shop.effective_plan_id}`),text('p',`Payment account: ${shop.payment_number} · ${shop.payment_holder}`),text('p',shop.payment_note),text('p','Last review: '+(shop.approval_note || 'No review yet'),'hint'),link('/'+shop.slug,'/'+shop.slug));
        const form=text('form'); const status=selectId(form,'status','Decision',[{id:'APPROVED',name:'Approve and publish'},{id:'REJECTED',name:'Reject / request corrections'},{id:'SUSPENDED',name:'Suspend public access'}]);
        field(form,'note','Reason shown to the seller','',{area:true,required:true,maxLength:1000});
        formSubmit(form,'Save review',async()=>{await api(`/admin/shops/${shop.id}`,{method:'PATCH',body:{...Object.fromEntries(new FormData(form)),status:status.value,revision:shop.revision}}); await adminDashboard('shops',page,filter);});
        const planForm=text('form'); selectId(planForm,'plan_id','Assign plan',plans.filter(p=>p.published),shop.effective_plan_id);
        const expires=field(planForm,'expires','Paid access expires (leave blank for Free)','',{type:'date'});
        field(planForm,'note','Payment reference or grant reason','',{required:true,maxLength:1000});
        formSubmit(planForm,'Save plan assignment',async()=>{const body=Object.fromEntries(new FormData(planForm)); delete body.expires; body.expires_at=expires.value ? Math.floor(new Date(expires.value+'T23:59:59Z').getTime()/1000) : null; body.revision=shop.revision; await api(`/admin/shops/${shop.id}/plan`,{method:'PATCH',body}); await adminDashboard('shops',page,filter);});
        const audit=text('section');
        card.append(form,planForm,button('Review history',async()=>{const data=await api(`/admin/shops/${shop.id}/audit`); audit.replaceChildren(...data.events.map(e=>append(text('div','','summary'),text('strong',`${e.action} · ${e.actor_name}`),text('p',JSON.stringify(JSON.parse(e.detail))),text('small',new Date(e.created_at*1000).toLocaleString()))));}),audit,button('Open shop support ticket',()=>ticketForm({shop_id:shop.id,requester_id:shop.owner_id,subject:`Support for ${shop.name}`}))); content().append(card);
      }
      if(!shops.length) content().append(text('p','No shops in this view.','muted')); pager(content(),page,shops.length,p=>adminDashboard('shops',p,filter));
    }
    if(section==='plans') {
      const {plans}=await api('/admin/plans');
      content().append(text('p','Prices are monthly. Changes affect the displayed offer and product limits; they do not charge customers. Free always stays at 10 products.','hint'));
      for(const plan of plans) {
        if(plan.id==='free') {content().append(append(text('div','','panel'),text('h3','Free · 10 products · no charge'))); continue;}
        const form=text('form','','panel'); field(form,'name','Plan name',plan.name,{required:true,maxLength:80});
        field(form,'product_limit','Product limit',plan.product_limit,{type:'number',min:11,max:100000,step:1,required:true});
        const price=field(form,'price','Monthly price',plan.monthly_price_minor===null ? '' : (plan.monthly_price_minor/100).toFixed(2),{type:'number',min:0.01,max:9999999.99,step:0.01,required:true});
        field(form,'currency','Currency',plan.currency,{select:['USD','EUR','GBP','AED','TRY','IRR']});
        const published=field(form,'published','Publish on pricing page',plan.published,{type:'checkbox'});
        formSubmit(form,'Save pricing',async()=>{const body=Object.fromEntries(new FormData(form)); delete body.price; body.monthly_price_minor=Math.round(Number(price.value)*100); body.product_limit=Number(body.product_limit); body.published=published.checked; body.revision=plan.revision; await api('/admin/plans/'+plan.id,{method:'PATCH',body}); await adminDashboard('plans');}); content().append(form);
      }
    }
    if(section==='orders') {
      search(content(),'Search order ID, customer name or phone',(p,q)=>adminDashboard('orders',p,'',q));
      const {orders}=await api(`/admin/orders?page=${page}&q=${encodeURIComponent(query)}`);
      for(const order of orders) {
        const card=orderCard(order); card.prepend(text('h3',order.shop_name),text('p',`${order.customer_name} · ${order.customer_phone}`));
        if(order.failed_notifications) {
          const retry=text('form'); field(retry,'note','Why retry failed notifications?','',{required:true,maxLength:500});
          formSubmit(retry,'Retry failed notifications',async()=>{await api(`/admin/orders/${order.id}/retry-notifications`,{method:'POST',body:Object.fromEntries(new FormData(retry))}); await adminDashboard('orders',page,'',query);}); card.append(retry);
        } content().append(card);
      } pager(content(),page,orders.length,p=>adminDashboard('orders',p,'',query));
    }
    if(section==='customers') {
      search(content(),'Search name or phone',(p,q)=>adminDashboard('customers',p,'',q));
      const {customers}=await api(`/admin/customers?page=${page}&q=${encodeURIComponent(query)}`);
      for(const customer of customers) content().append(append(text('article','','panel'),text('h3',customer.name),text('p',customer.phone),text('p',`${customer.shop_count} stores · ${customer.order_count} orders`),button('Open support conversation',()=>ticketForm({requester_id:customer.id,subject:'Platform support'}))));
      pager(content(),page,customers.length,p=>adminDashboard('customers',p,'',query));
    }
  }
  async function sellerTools(shop,parent,onCategoryChange) {
    const {usage}=await api(`/merchant/${shop.id}/usage`);
    parent.append(append(text('div','','summary'),text('strong',`${shop.status} · ${usage.plan_name} · ${usage.product_count}/${usage.product_limit} products`),text('p',shop.approval_note || 'New shops need platform approval before customers can order.'),...(usage.product_count>usage.product_limit ? [text('p','Your catalog exceeds the current plan. Only the first product slots remain available; archive unused products or upgrade.')] : []),button('Plans & upgrades',()=>pricingPage(shop)),button('Contact platform support',()=>ticketForm({shop_id:shop.id}))));
    const customerDetails=append(text('details','','panel'),text('summary','Customers')); const categoryDetails=append(text('details','','panel'),text('summary','Categories'));
    const customers=text('section'); const categoryPanel=text('section'); customerDetails.append(customers); categoryDetails.append(categoryPanel); parent.append(customerDetails,categoryDetails);
    const loadCustomers=async(page=1,query='')=>{
      customers.replaceChildren(text('h3','Your customers'));
      search(customers,'Search customer name or phone',loadCustomers);
      const data=await api(`/merchant/${shop.id}/customers?page=${page}&q=${encodeURIComponent(query)}`);
      for(const c of data.customers) customers.append(append(text('div','','summary'),text('strong',c.name),text('p',c.phone),text('p',`${c.order_count} orders · ${money(c.approved_total_minor,data.currency)} approved`)));
      if(!data.customers.length) customers.append(text('p','Customers appear after ordering from this store.','muted')); pager(customers,page,data.customers.length,p=>loadCustomers(p,query));
    };
    const loadCategories=async()=>{
      const {categories}=await api(`/merchant/${shop.id}/categories`); categoryPanel.replaceChildren(text('h3','Product categories'));
      const create=text('form'); field(create,'name','New category','',{required:true,maxLength:80});
      formSubmit(create,'Add category',async()=>{await api(`/merchant/${shop.id}/categories`,{method:'POST',body:Object.fromEntries(new FormData(create))}); await loadCategories(); await onCategoryChange();}); categoryPanel.append(create);
      for(const category of categories) {
        const form=text('form','','category-row'); field(form,'name','Category',category.name,{required:true,maxLength:80});
        formSubmit(form,'Rename',async()=>{await api(`/merchant/${shop.id}/categories/${category.id}`,{method:'PATCH',body:Object.fromEntries(new FormData(form))}); await loadCategories(); await onCategoryChange();});
        form.append(button('Remove category',async()=>{await api(`/merchant/${shop.id}/categories/${category.id}`,{method:'DELETE'}); await loadCategories(); await onCategoryChange();})); categoryPanel.append(form);
      }
    };
    await loadCustomers(); await loadCategories();
  }
  return {adminDashboard,supportDashboard,ticketForm,pricingPage,sellerTools,selectId};
}
