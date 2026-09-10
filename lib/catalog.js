export async function listCatalog(env,url,shop,helpers) {
  const {ApiError,json,optional,priceMinor,pageOffset}=helpers;
  const params=url.searchParams;
  const q=optional(params.get('q') || '','Search',100);
  const category=optional(params.get('category') || '','Category',80);
  const seller=optional(params.get('seller') || '','Store username',40);
  const currency=shop?.currency || params.get('currency') || '';
  if(currency && !['USD','EUR','GBP','AED','TRY','IRR'].includes(currency)) throw new ApiError(400,'Unsupported currency.');
  const sort=params.get('sort') || 'newest';
  const sorts={newest:'p.created_at DESC,p.id DESC',name:'p.name COLLATE NOCASE,p.id',price_asc:'p.price_minor,p.id',price_desc:'p.price_minor DESC,p.id'};
  if(!Object.hasOwn(sorts,sort)) throw new ApiError(400,'Invalid sort order.');
  const min=params.get('min') ? priceMinor(params.get('min')) : null;
  const max=params.get('max') ? priceMinor(params.get('max')) : null;
  if(min!==null && max!==null && min>max) throw new ApiError(400,'Minimum price must not exceed maximum price.');
  if(!currency && (min!==null || max!==null || sort.startsWith('price'))) throw new ApiError(400,'Choose a currency before comparing prices.');
  const where=`${shop ? 'p.shop_id=?' : 'p.is_public=1'} AND (?='' OR instr(lower(p.name||' '||p.description),lower(?))>0)
    AND (?='' OR p.category_id=?) AND (?='' OR s.slug=?) AND (?='' OR s.currency=?)
    AND (? IS NULL OR p.price_minor>=?) AND (? IS NULL OR p.price_minor<=?)`;
  const args=[...(shop?[shop.id]:[]),q,q,category,category,seller,seller,currency,currency,min,min,max,max];
  const products=(await env.DB.prepare(`SELECT p.id,p.shop_id,p.name,p.description,p.price_minor,p.category_id,p.is_public,
    s.name AS shop_name,s.slug AS shop_slug,s.currency,c.name AS category_name
    FROM available_products p JOIN shops s ON s.id=p.shop_id LEFT JOIN categories c ON c.id=p.category_id
    WHERE ${where} ORDER BY ${sorts[sort]} LIMIT 50 OFFSET ?`).bind(...args,pageOffset(url)).all()).results;
  const total=await env.DB.prepare(`SELECT count(*) AS total FROM available_products p JOIN shops s ON s.id=p.shop_id WHERE ${where}`).bind(...args).first();
  const categories=(await env.DB.prepare(`SELECT DISTINCT c.id,c.name,s.name AS shop_name FROM categories c
    JOIN available_products p ON p.category_id=c.id JOIN shops s ON s.id=c.shop_id
    WHERE ${shop?'p.shop_id=?':'p.is_public=1'} ORDER BY c.name LIMIT 100`).bind(...(shop?[shop.id]:[])).all()).results;
  return json({shop,products,categories,total:total.total,page:pageOffset(url)/50+1});
}
