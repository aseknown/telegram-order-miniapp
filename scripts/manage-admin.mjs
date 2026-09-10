import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2);
const action=args[0];
const idIndex=args.indexOf('--telegram-id');
const telegramId=idIndex>=0 ? args[idIndex+1] : '';
const local=args.includes('--local'); const remote=args.includes('--remote');
if(!['grant','revoke'].includes(action) || !/^[1-9]\d{0,15}$/.test(telegramId) || local===remote) {
  console.error('Usage: npm run admin:manage -- grant|revoke --telegram-id NUMERIC_ID --local|--remote');
  process.exit(1);
}
// IDs are validated as decimal digits, and arguments bypass shell interpolation.
// There is deliberately no application endpoint for bootstrapping administrator access.
const sql=action==='grant'
  ? `INSERT INTO platform_admins (customer_id,created_at) SELECT id,CAST(strftime('%s','now') AS INTEGER) FROM customers WHERE telegram_id='${telegramId}' AND true ON CONFLICT(customer_id) DO NOTHING RETURNING customer_id;`
  : `DELETE FROM platform_admins WHERE customer_id IN (SELECT id FROM customers WHERE telegram_id='${telegramId}') RETURNING customer_id;`;
execFileSync(process.execPath,[fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url)),
  'd1','execute','telegram-orders',local?'--local':'--remote','--command',sql],{stdio:'inherit'});
console.log('A returned customer_id confirms the change. No returned row means no matching verified account or no change was needed.');
