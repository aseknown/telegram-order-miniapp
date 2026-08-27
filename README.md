# Telegram Order Shop — Cloudflare Pages Edition

Runs the Mini App, API and D1 order database on Cloudflare Pages.

## Order flow

Customer:
`/start` → Open Shop → choose product → see manual payment details → upload receipt → submit.

Admin:
receipt arrives in Telegram → verify real transfer → **Attach product link** → send URL → **Accept & Send** → bot delivers URL to that customer.

No payment gateway is used.

## 1) Create a bot

Create the bot with `@BotFather` and copy its token. Also get your numeric Telegram user ID; that becomes `ADMIN_TELEGRAM_ID`.

## 2) Install

```bash
npm install
npx wrangler login
```

## 3) Create D1

```bash
npx wrangler d1 create telegram-orders
```

Copy the returned database ID into `wrangler.toml`:

```toml
database_id = "YOUR_REAL_D1_ID"
```

Initialize it:

```bash
npm run db:remote
```

## 4) Edit settings

In `wrangler.toml`, edit:

- `ADMIN_TELEGRAM_ID`
- `BOT_USERNAME`
- `CURRENCY`
- `PAYMENT_LABEL`
- `PAYMENT_NUMBER`
- `PAYMENT_HOLDER`
- `PAYMENT_NOTE`
- `PRODUCTS_JSON`

Do not put the bot token in this file.

## 5) First deploy

```bash
npm run deploy
```

You will get a URL such as:

```text
https://telegram-order-shop.pages.dev
```

Put the exact URL in:

```toml
PUBLIC_URL = "https://telegram-order-shop.pages.dev"
```

Deploy again:

```bash
npm run deploy
```

No custom domain is required.

Because the project contains Pages Functions, use Wrangler or Git integration rather than dashboard drag-and-drop.

## 6) Add secrets

Generate a webhook secret:

```bash
openssl rand -hex 32
```

Then:

```bash
npx wrangler pages secret put BOT_TOKEN --project-name=telegram-order-shop
npx wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name=telegram-order-shop
```

Paste the relevant value each time.

You may also add them in Cloudflare Dashboard → Workers & Pages → your project → Settings → Variables and Secrets.

## 7) Register Telegram webhook

```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url":"https://telegram-order-shop.pages.dev/api/telegram",
    "secret_token":"YOUR_WEBHOOK_SECRET",
    "allowed_updates":["message","callback_query"]
  }'
```

Check:

```bash
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/getWebhookInfo"
```

## 8) Use it

Open the bot and send:

```text
/start
```

Tap **🛍 Open Shop**.

The Mini App must be opened from Telegram for real order submission because the backend validates Telegram `initData`.

## Admin controls

New order:

- `🔗 Attach product link`
- `❌ Reject`
- `💬 Message customer`
- `↗ Open customer chat` if they have a public username

After you attach an `http://` or `https://` URL:

- `✅ Accept & Send`
- `🔗 Change product link`

The code will not accept an order unless a delivery link is attached.

## Security

- Verify money in your actual bank/payment account; screenshots can be forged.
- Never request CVV, PIN, OTP, banking passwords, recovery phrases or similar secrets.
- Keep `BOT_TOKEN` as a Cloudflare encrypted secret.
- Telegram Mini App `initData` is HMAC-validated server-side.
- Product prices are calculated server-side from `PRODUCTS_JSON`.
- Telegram webhook requests are checked using `TELEGRAM_WEBHOOK_SECRET`.
- Prefer unique or private product links if access should not be shared.


---

# CI/CD and local SQLite-style database

## Important: raw SQLite file on Cloudflare production

Cloudflare Pages Functions do not provide a normal persistent writable disk for an application-owned
`orders.sqlite` file. For production this project therefore uses **Cloudflare D1**, which uses SQLite
semantics and is directly available to Pages/Workers.

For local development, Wrangler persists the local D1 emulator to disk. Use:

```bash
npm run db:local:persist
```

The local database state is stored beneath:

```text
.wrangler/state/
```

This is the closest supported "SQLite file DB" workflow while keeping Cloudflare Pages as the production host.

If you absolutely require a single `orders.sqlite` file in production, deploy the backend to a VPS/container
host with a persistent volume instead of Cloudflare Pages.

## One-time Cloudflare setup

```bash
npm install
npx wrangler login
npm run cf:setup
```

Then edit `wrangler.toml`, add secrets:

```bash
npm run cf:secrets
```

Set environment values and register Telegram webhook:

```bash
export BOT_TOKEN="..."
export TELEGRAM_WEBHOOK_SECRET="..."
export PUBLIC_URL="https://YOUR_PROJECT.pages.dev"
npm run cf:webhook
```

Deploy manually anytime:

```bash
npm run cf:deploy
```

## GitHub Actions deployment

Push this repository to GitHub.

In your GitHub repository add Actions secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The included workflow:

```text
.github/workflows/deploy.yml
```

runs automatically on every push to `main`:

1. `npm ci`
2. applies the D1 schema
3. deploys the Pages project

Your Telegram secrets (`BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`) remain stored in Cloudflare Pages,
not in GitHub or source control.
