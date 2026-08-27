#!/usr/bin/env bash
set -euo pipefail

: "${BOT_TOKEN:?Set BOT_TOKEN first}"
: "${TELEGRAM_WEBHOOK_SECRET:?Set TELEGRAM_WEBHOOK_SECRET first}"
: "${PUBLIC_URL:?Set PUBLIC_URL first, e.g. https://telegram-order-shop.pages.dev}"

curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\":\"${PUBLIC_URL%/}/api/telegram\",
    \"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",
    \"allowed_updates\":[\"message\",\"callback_query\"]
  }"

echo
