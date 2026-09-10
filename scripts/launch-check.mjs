// Read-only checks against the exact deployed origin. Never prints credentials or customer data.
const argument=process.argv.find(value=>value.startsWith('--url='));
if(!argument) {console.error('Usage: npm run launch:check -- --url=https://YOUR_LAUNCH_DOMAIN'); process.exit(1);}
const origin=new URL(argument.slice(6));
if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw new Error('Provide a public HTTPS origin without credentials, path, or query.');
const checks=[['/api/v1/health',200,data=>data.ready===true && data.version==='marketplace-4'],['/api/v1/catalog',200,data=>Array.isArray(data.products)],['/api/v1/plans',200,data=>data.plans?.some(plan=>plan.id==='free' && plan.product_limit===10)],['/api/v1/me',401,()=>true]];
const results=await Promise.all(checks.map(async([path,status,validate])=>{
  try {const response=await fetch(new URL(path,origin),{redirect:'error',signal:AbortSignal.timeout(15000)}); const data=await response.json().catch(()=>null); return {path,ok:response.status===status && data!==null && validate(data),reason:`HTTP ${response.status}${data===null?' (not JSON)':''}`};}
  catch(error) {return {path,ok:false,reason:error.cause?.code || error.name};}
}));
for(const result of results) console.log(`${result.ok?'PASS':'FAIL'} ${result.path}${result.ok?'':' — '+result.reason}`);
console.log('Also verify live Telegram order/receipt delivery, the notification scheduler, WooCommerce sync, privacy/support information and a backup restore before marketing.');
if(results.some(result=>!result.ok)) process.exitCode=1;
