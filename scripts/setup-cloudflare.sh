#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-telegram-order-shop}"
DB_NAME="${DB_NAME:-telegram-orders}"

echo "==> Checking Wrangler login"
npx wrangler whoami >/dev/null

echo "==> Creating D1 database if needed"
set +e
DB_OUTPUT="$(npx wrangler d1 create "$DB_NAME" 2>&1)"
STATUS=$?
set -e

if [ $STATUS -eq 0 ]; then
  echo "$DB_OUTPUT"
  DB_ID="$(printf "%s\n" "$DB_OUTPUT" | sed -n 's/.*database_id = "\([^"]*\)".*/\1/p' | head -n1)"
else
  echo "D1 create returned non-zero; database may already exist."
  echo "$DB_OUTPUT"
  DB_ID="$(npx wrangler d1 list --json | node -e '
    let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
      const name=process.argv[1]; const x=JSON.parse(s); const db=x.find(v=>v.name===name);
      if(db) process.stdout.write(db.uuid||db.id||"");
    });' "$DB_NAME")"
fi

if [ -z "${DB_ID:-}" ]; then
  echo "Could not determine D1 database id."
  echo "Run: npx wrangler d1 list"
  exit 1
fi

echo "==> Updating wrangler.toml database_id"
node --input-type=commonjs - "$DB_ID" <<'NODE'
const fs = require("fs");
const id = process.argv[2];
for (const file of ["wrangler.toml", "wrangler.notifications.toml"]) {
  let s = fs.readFileSync(file,"utf8");
  s = s.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`);
  fs.writeFileSync(file, s);
}
NODE

echo "==> Applying database schema"
npx wrangler d1 migrations apply "$DB_NAME" --remote

echo "==> Initial deploy"
npx wrangler pages deploy public --project-name="$PROJECT_NAME"

echo
echo "Setup complete."
echo "Now:"
echo "1) Put your actual pages.dev URL into PUBLIC_URL in wrangler.toml"
echo "2) Set ADMIN_TELEGRAM_ID, BOT_USERNAME, payment details, and PRODUCTS_JSON"
echo "3) Add BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET with scripts/set-secrets.sh"
echo "4) Run scripts/deploy.sh"
