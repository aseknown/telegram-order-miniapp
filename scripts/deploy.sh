#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-telegram-order-shop}"
DB_NAME="${DB_NAME:-telegram-orders}"

echo "==> Applying migrations/schema"
npx wrangler d1 migrations apply "$DB_NAME" --remote

echo "==> Deploying Cloudflare Pages"
npx wrangler pages deploy public --project-name="$PROJECT_NAME"

npx wrangler deploy --config wrangler.notifications.toml

echo "==> Done"
