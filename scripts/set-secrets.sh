#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-telegram-order-shop}"

if [ -z "${BOT_TOKEN:-}" ]; then
  read -rsp "BOT_TOKEN: " BOT_TOKEN
  echo
fi
if [ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]; then
  read -rsp "TELEGRAM_WEBHOOK_SECRET: " TELEGRAM_WEBHOOK_SECRET
  echo
fi

printf "%s" "$BOT_TOKEN" | npx wrangler pages secret put BOT_TOKEN --project-name="$PROJECT_NAME"
printf "%s" "$TELEGRAM_WEBHOOK_SECRET" | npx wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name="$PROJECT_NAME"
printf "%s" "$BOT_TOKEN" | npx wrangler secret put BOT_TOKEN --config=wrangler.notifications.toml

echo "Secrets stored."
