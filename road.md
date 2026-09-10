The app is currently a Cloudflare Pages + D1 marketplace with a separate notification Worker. The marketplace changes are uncommitted, so do not deploy them directly until you review and commit them.

Current validation:

- `npm test`: 27/27 passed.
- `npm run build:check`: blocked by local Wrangler permissions/path access (`EPERM`), not a test failure.
- No production migration or deployment has been verified.
- `wrangler.toml` currently has a `workers.dev` URL, but the project is configured as Pages. Correct this before registering the Telegram webhook.

## 1. Review the uncommitted implementation

Run PowerShell:

```powershell
git status --short
git diff --check
git diff --stat
git diff
```

Review especially:

```powershell
Get-Content wrangler.toml
Get-Content MARKETPLACE.md
Get-Content .github/workflows/deploy.yml
```

Then test locally:

```powershell
npm.cmd ci
Copy-Item .dev.vars.example .dev.vars
notepad .dev.vars

npm.cmd run db:local
npm.cmd test
```

Use a separate Telegram development bot locally. Never use the production bot token in `.dev.vars`.

After resolving the Wrangler local permission problem, run:

```powershell
npm.cmd run build:check
```

Do not commit secrets, `.dev.vars`, `.wrangler/state`, or generated files.

## 2. Prepare Cloudflare

Install Node.js 22 or newer, then:

```powershell
npm.cmd ci
npx.cmd wrangler login
npx.cmd wrangler whoami
```

Create the Pages project if it does not exist:

```powershell
npx.cmd wrangler pages project create telegram-order-shop --production-branch main
```

Create or inspect D1:

```powershell
npx.cmd wrangler d1 list
npx.cmd wrangler d1 create telegram-orders
```

Copy the returned database ID into both:

```text
wrangler.toml
wrangler.notifications.toml
```

Example:

```toml
database_id = "YOUR_REAL_D1_DATABASE_ID"
```

Verify the configuration:

```powershell
Get-Content wrangler.toml
Get-Content wrangler.notifications.toml
```

## 3. Configure public variables

Edit `wrangler.toml`:

```powershell
notepad wrangler.toml
```

Set these values:

```toml
name = "telegram-order-shop"
pages_build_output_dir = "public"

[vars]
PUBLIC_URL = "https://telegram-order-shop.pages.dev"
ADMIN_TELEGRAM_ID = "YOUR_PLATFORM_ADMIN_TELEGRAM_ID"
BOT_USERNAME = "YOUR_BOT_USERNAME"
CURRENCY = "USD"

PAYMENT_LABEL = "Card / bank transfer number"
PAYMENT_NUMBER = "YOUR_PAYMENT_NUMBER"
PAYMENT_HOLDER = "YOUR_ACCOUNT_HOLDER"
PAYMENT_NOTE = "Pay the exact total, then upload a screenshot of the completed transfer."
```

Important:

- `PUBLIC_URL` must be the exact public Pages URL customers will use.
- Do not leave the existing `workers.dev` value unless that Worker genuinely serves this application.
- `ADMIN_TELEGRAM_ID` is only the legacy/single-shop administrator setting. Marketplace admin access is granted through the database CLI.
- `PRODUCTS_JSON` is legacy configuration and is not imported automatically into marketplace shops.
- Do not put `BOT_TOKEN` in `wrangler.toml`.

## 4. Apply migrations to staging first

Use a separate staging D1 database if possible.

```powershell
npx.cmd wrangler d1 migrations apply telegram-orders --remote
```

Do not manually rerun migrations `0002` or `0003`. Wrangler tracks applied migrations.

Inspect migration status:

```powershell
npx.cmd wrangler d1 migrations list telegram-orders --remote
```

The third migration places existing shops into `PENDING`. They must be reviewed and approved again.

## 5. Store encrypted secrets

Create a strong webhook secret:

```powershell
$webhookSecret = [Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$webhookSecret
```

Store the Pages secrets:

```powershell
npx.cmd wrangler pages secret put BOT_TOKEN --project-name=telegram-order-shop
npx.cmd wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name=telegram-order-shop
```

Paste the values when prompted.

Store the bot token separately on the notification Worker:

```powershell
npx.cmd wrangler secret put BOT_TOKEN --config wrangler.notifications.toml
```

The Pages project and notification Worker do not share secrets automatically.

## 6. Deploy staging

Deploy Pages:

```powershell
npx.cmd wrangler pages deploy public --project-name=telegram-order-shop
```

Deploy the notification Worker:

```powershell
npx.cmd wrangler deploy --config wrangler.notifications.toml
```

Check deployments:

```powershell
npx.cmd wrangler pages deployment list --project-name=telegram-order-shop
npx.cmd wrangler deployments list --config wrangler.notifications.toml
```

## 7. Register the Telegram webhook

Set environment variables only in the current PowerShell session:

```powershell
$env:BOT_TOKEN = "YOUR_BOT_TOKEN"
$env:TELEGRAM_WEBHOOK_SECRET = "YOUR_WEBHOOK_SECRET"
$env:PUBLIC_URL = "https://telegram-order-shop.pages.dev"
```

Register the webhook:

```powershell
$body = @{
  url = "$($env:PUBLIC_URL.TrimEnd('/'))/api/telegram"
  secret_token = $env:TELEGRAM_WEBHOOK_SECRET
  allowed_updates = @("message", "callback_query")
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.telegram.org/bot$($env:BOT_TOKEN)/setWebhook" `
  -ContentType "application/json" `
  -Body $body
```

Verify it:

```powershell
Invoke-RestMethod `
  -Uri "https://api.telegram.org/bot$($env:BOT_TOKEN)/getWebhookInfo"
```

The webhook URL must point to:

```text
https://YOUR_PUBLIC_HOST/api/telegram
```

## 8. Grant the first platform administrator

The intended administrator must first:

1. Open the bot.
2. Send `/start`.
3. Share their phone contact through Telegram.
4. Complete phone verification.

Then grant the role:

```powershell
npm.cmd run admin:manage -- grant `
  --telegram-id YOUR_NUMERIC_TELEGRAM_ID `
  --remote
```

Verify the account can open:

```text
https://YOUR_PUBLIC_HOST/admin
```

Use `revoke` to remove access:

```powershell
npm.cmd run admin:manage -- revoke `
  --telegram-id YOUR_NUMERIC_TELEGRAM_ID `
  --remote
```

## 9. Full staging acceptance test

Test all of these before production:

```text
/start
Share phone contact
Open marketplace
Create seller shop
Edit shop profile and payment details
Add categories
Add products
Open public shop URL
Submit an order with receipt
Seller receives Telegram notification
Seller verifies the bank transfer
Seller attaches the digital-product URL
Seller accepts and sends the order
Customer receives the delivery URL
Admin can review the shop and order
Failed notification can be retried
Suspended shop cannot receive orders
```

Also test:

- Two sellers with separate shops.
- A seller cannot view another seller’s customers or orders.
- A customer cannot download another customer’s receipt.
- Editing an approved shop returns it to `PENDING`.
- Duplicate order submission does not create duplicate orders.
- Product quota enforcement.
- WooCommerce token rotation and revocation.

## 10. Seller onboarding journey

A seller’s path is:

1. Open the Telegram bot and send `/start`.
2. Share their own Telegram contact.
3. Complete phone verification.
4. Open `/merchant`.
5. Create a shop with:
   - Store name
   - URL username/slug
   - Description
   - Currency
   - Bank/card payment number
   - Account-holder name
   - Payment instructions
6. Add categories and products.
7. Keep the shop in `PENDING` while the platform reviews it.
8. Platform admin checks:
   - Seller identity
   - Store information
   - Payment details
   - Product legitimacy
   - Store policies and support readiness
9. Admin approves, rejects with a reason, or suspends the shop.
10. After approval, the seller shares:

```text
https://YOUR_PUBLIC_HOST/SELLER_SLUG
```

11. For WooCommerce:
   - Install WooCommerce.
   - Install the ZIP from `artifacts/shopline-connector.zip`.
   - Activate the connector.
   - Create the store in `/merchant`.
   - Generate the integration token.
   - Enter the endpoint and token in WordPress.
   - Run “Sync existing products”.
12. For each order, the seller verifies the real bank transfer, then approves or rejects the order.

The platform does not automatically verify bank payments, provide refunds, reserve inventory, support variable products, or provide automatic paid subscriptions. Those policies must be defined before public launch.

## 11. Production deployment gate

Only after staging passes:

```powershell
git diff --check
npm.cmd test
npm.cmd run build:check
```

Then commit the reviewed changes:

```powershell
git add .
git commit -m "Implement Telegram marketplace"
```

Push to `main` only if you want GitHub Actions to deploy:

```powershell
git push origin main
```

Required GitHub Actions secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The workflow applies D1 migrations, deploys Pages, and deploys the notification Worker.

Before production, still resolve these release blockers:

- Backup and restore rehearsal.
- Rollback rehearsal.
- Live Telegram end-to-end test.
- Live notification Worker test.
- WordPress/PHP integration test.
- Monitoring and failed-notification alerts.
- D1 storage and attachment capacity review.
- Privacy, retention, refund, and seller terms.
- Migration plan for old single-shop orders and customers.

No deployment was performed during this review.