#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-telegram-order-shop}"
DB_NAME="${DB_NAME:-telegram-orders}"

echo "==> Applying migrations/schema"
npx wrangler d1 execute "$DB_NAME" --remote --file=./migrations/0001_init.sql

echo "==> Deploying Cloudflare Pages"
npx wrangler pages deploy public --project-name="$PROJECT_NAME"

echo "==> Done"
