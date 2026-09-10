# Marketplace implementation and release guide

This repository now contains a first marketplace implementation on the existing Cloudflare Pages / D1 stack. It is not yet a verified production release. No remote migration or deployment was performed during implementation.

## What works in this implementation

- `/` lists stores and `/{username}` opens a store. Browsing works outside Telegram.
- `/merchant` lets a verified owner create up to ten stores, edit each profile and bank-transfer details, manage products and categories, see only their own buyers and order totals, connect WooCommerce and review orders.
- `/admin` is the super-admin dashboard for shop verification, suspension, customer/seller lookup, order/receipt investigation, failed-notification retries and pricing. Roles are stored in `platform_admins` and granted explicitly through the operator CLI; a normal signup never gets this role.
- Shops start `PENDING`. Only `APPROVED` shops are public and can receive new orders. Changes to an approved profile require a new review. Suspension hides the store and blocks new orders while preserving historical order/support access. Review decisions require a reason and matching revision, and are audited.
- `/support` provides database-backed conversations for order issues and private platform support. Shared order tickets are accessible to that order's customer, seller and platform admins; private tickets remain limited to their requester and platform admins. Admins can open a conversation for a seller/customer, reply, mark waiting or resolve it. Replies are in-app; Telegram support-ticket notifications are not implemented.
- `/pricing` displays published plans. Free is fixed at 10 retained products per shop, across manual and WooCommerce products. Hidden products count; archived products do not. Database triggers enforce the limit under concurrent requests. Pro is initially an unpublished 100-product draft with no price; an admin must choose and publish its monthly price.
- Every customer has a global UUID, a unique international phone number and a unique Telegram identity. The same account can buy from any shop and own shops.
- Phone registration trusts only a bot webhook protected with `TELEGRAM_WEBHOOK_SECRET`, a private chat, and a contact whose `user_id` equals the sender. Client-side contact fields are never trusted. Existing account conflicts require recovery; they never silently merge accounts or transfer shop ownership.
- Server-validated Telegram `initData` authenticates customer and merchant API requests, with a one-hour freshness limit. Ordinary-browser SMS authentication is not implemented.
- Shop ownership scopes product edits, order reviews, integration tokens and attachment downloads. Customer histories are restricted to their own orders.
- Orders save price, product name, currency and bank details as snapshots. Amounts use integer minor units. Supported currencies currently use a fixed two-decimal display; IRR is rial, not toman.
- A D1 transaction saves the order, 1–3 attachment BLOBs and Telegram notification jobs. Each attachment is at most 1 MB. File headers and MIME types are checked. Files are served as authenticated downloads, never public URLs.
- Order submission uses an idempotency key bound to customer and a hash of the submitted contents. The browser retains the key after a network error, and changes it when the checkout contents change.
- Admin details, every receipt, and customer confirmation are separate durable Telegram jobs. Receipt documents preserve the original bytes. Payment approval/rejection is audited and enqueues the customer result transactionally. The owner can attach an HTTPS digital-product link when approving; it is saved in the order and sent to the customer.
- The notification worker leases jobs, uses 15-second network timeouts and exponential backoff, and stops after eight failed attempts. Telegram does not support a send idempotency key: a process crash after a successful send can produce a duplicate notification, but not a duplicate order. Failed jobs remain in D1 and are flagged in the merchant order list.
- Authenticated mutations are limited to 30 per customer per minute; integration pushes to 120 per shop per minute. These are database limits, not a replacement for edge abuse protection.

## Super-admin setup and seller release workflow

Apply all migrations before starting the new application. Migration `0003_shop_management.sql` preserves existing marketplace data and places **existing shops in PENDING too**. Review and approve them before directing customers to the new version. It does not automatically trust the previous global Telegram admin ID.

1. The intended platform admin signs in through Telegram and verifies their own phone.
2. An operator with trusted database access explicitly grants that verified account the role:

   ```powershell
   # Local database:
   npm.cmd run admin:manage -- grant --telegram-id YOUR_NUMERIC_TELEGRAM_ID --local
   # Production database, only when ready to grant production access:
   npm.cmd run admin:manage -- grant --telegram-id YOUR_NUMERIC_TELEGRAM_ID --remote
   ```

   The ID must be replaced with the intended person's numeric Telegram ID. A returned `customer_id` confirms the change. Use `revoke` instead of `grant` to remove access. No endpoint accepts self-assigned roles, and no new environment secret is required for this role.
3. Refresh the account and open `/admin`. Review each shop's owner, profile and payment details. Record a reason and approve, reject or suspend it. Rejected sellers can correct their profile and resubmit; suspended shops remain suspended until a platform admin changes their status.
4. The seller prepares their catalog and categories in `/merchant`, then shares the shop URL after approval.
5. Use the support inbox for disputes and onboarding questions. Platform admins investigate orders and receipts but do not bypass the seller's bank-payment decision. Failed Telegram notifications can be requeued with an audit reason; already-sent notifications are left alone.

## Pricing and upgrade operations

The free offer is ready: **10 products per shop, no monthly charge**. It includes categories, customer/order management, support and WooCommerce sync within that limit.

There is no guessed public paid price. In `/admin` → **Pricing plans**, set the Pro name, product cap, monthly amount and currency, then publish it. The public pricing page shows only published plans. Sellers can request an upgrade through a private support ticket linked to their shop.

After independently verifying a subscription payment, or deciding to grant access, the admin assigns the plan with a future expiry and a payment reference/grant reason. The audit record includes the offered price and currency. No money is collected by this feature, and there are no automatic charges or renewals. Gateway billing can be added separately after the provider and commercial rules are selected.

Expired paid access falls back to Free without deleting records. When the retained catalog exceeds the current limit, only its first ten retained product slots (in database insertion order, including hidden slots) are eligible for public listing/checkout. Sellers can archive unwanted manual products to choose which products remain within their allowance, or upgrade. Imported products must be archived in WooCommerce. Restoring a product also checks the quota. Editing an existing product at the limit is allowed.

Changing a paid plan's product limit affects its current members; changing its price updates future displayed offers and never initiates a charge. Review those changes with existing subscribers before publishing them. For release, validate an upgrade, expiry, downgrade and renewal grant in staging.

## Fixing the original bot/admin error

The previous `/api/order` checked `BOT_TOKEN` and `ADMIN_TELEGRAM_ID` before reading the upload. Missing deployment configuration caused the error; it was not an image-format diagnosis.

Check the Cloudflare application serving the exact URL customers use. `wrangler.toml` currently describes a **Pages** project, while its `PUBLIC_URL` ends in `workers.dev`. Verify whether that host serves this Pages deployment or a separate Worker; secrets saved to another application do not apply. Also distinguish production from preview environments.

For the Pages project, configure encrypted secrets without putting values in source code or chat:

```powershell
npx.cmd wrangler pages secret put BOT_TOKEN --project-name=telegram-order-shop
npx.cmd wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name=telegram-order-shop
```

Configure `BOT_USERNAME`, the exact public HTTPS origin in `PUBLIC_URL`, and the D1 binding `DB`. Register `/api/telegram` as the Telegram webhook using the same secret. Redeploy the correct application after changing configuration. Send `/start` to the bot and share your phone before opening `/merchant`.

New marketplace orders derive the recipient from the verified shop owner; they do not use the global `ADMIN_TELEGRAM_ID`. The legacy `/api/order` is disabled by default. `LEGACY_CHECKOUT_ENABLED=true` explicitly restores it for rollback compatibility, with the original single-shop configuration and known nontransactional Telegram-delivery limitations. Old bot callbacks and old database records are retained. The new marketplace does not automatically reassign old orders or import `PRODUCTS_JSON`; establish the verified owner before performing a reviewed legacy-data migration.

## Local development and checks

Node 22.13+ is needed for the tests' built-in SQLite adapter (Node 26 was used locally).

```powershell
npm.cmd ci
Copy-Item .dev.vars.example .dev.vars
# Edit .dev.vars locally with your development bot values.
npm.cmd run db:local
npm.cmd test
npm.cmd run build:check
npm.cmd run dev
```

Keep `.dev.vars` private. Do not use a production bot for automated tests. Tests use an in-memory SQLite database, real migrations, the real HMAC validator and mocked Telegram transport. The 27 tests cover authorization, identity conflicts, money validation, idempotency, rollback, private receipt access, review state, token isolation, stale sync updates, notification retries, shop moderation, concurrent quotas, plan expiry, categories, scoped customer lists and support privacy. The Functions build and all three migrations also passed on an isolated local Cloudflare D1 database.

## WooCommerce connector

Zip the `wordpress/shopline-connector` directory and install the ZIP through WordPress Plugins → Add New → Upload Plugin. Activate WooCommerce first, then activate the connector.

1. Create a store in `/merchant` with the same currency as WooCommerce.
2. Generate its integration token. Copy the endpoint and token into WooCommerce → Shopline in WordPress.
3. Save, then click **Sync existing products**. The plugin queues pages of 20 products.
4. Product changes, deletion, visibility and stock availability schedule updates automatically. Use a real server cron for WordPress scheduled events on low-traffic sites.
5. Rotate or revoke the token from the store dashboard. Tokens are hashed in marketplace D1 and shown once; WordPress keeps its token in a non-autoloaded option. Protect WordPress database backups accordingly.

Only simple products are offered. Variable/grouped/external products are disabled by the connector; there is no variation selector, stock reservation or WooCommerce order write-back. Decimal prices above two places are rejected. Imported products are edited in WooCommerce. The connector uses HTTPS, disallows redirects, uses WordPress safe HTTP requests, and retries only network/429/5xx failures up to eight attempts. Versions prevent delayed snapshots replacing newer ones. A site cloned from another WordPress database must receive a new shop token before enabling sync.

## Deployment sequence (operator action)

1. Confirm which Cloudflare application/domain serves the app, and set both Wrangler files to the intended D1 ID. Preserve backups and rehearse restoration before modifying production.
2. Apply migrations to a staging database using `wrangler d1 migrations apply`. Migration 0002 is additive; 0001 uses `IF NOT EXISTS`, so existing untracked initial schemas can be adopted by Wrangler's migration ledger. Do not manually reapply 0002 or 0003. Grant a verified super-admin account and review existing shops after 0003. Check that no old shop slug conflicts with the newly reserved `/pricing` or `/support` routes before release.
3. Configure the Pages bot secrets and webhook, and validate phone registration and a full two-store order flow in staging.
4. Deploy `workers/notifications.js` using `npm run notifications:deploy`. Set the same bot token on this separate Worker:

   ```powershell
   npx.cmd wrangler secret put BOT_TOKEN --config wrangler.notifications.toml
   ```

   Its minute cron drains up to five jobs per invocation. Increase throughput only after measuring load and respecting Telegram rate limits. Pages attempts immediate delivery too, but the scheduler is necessary for reliable retries.
5. After staging validation, apply the remote migrations and deploy Pages plus the scheduler. Existing GitHub deployment automation now runs tests, builds, applies pending migrations and deploys both applications. Worker secrets are separate from Pages secrets.

To inspect undelivered jobs, query `notifications` by `state`, `attempts`, `error_code` and `next_attempt`. After fixing a delivery issue, an operator can deliberately reset the affected FAILED jobs to PENDING with attempts=0 and next_attempt=0. Do not indiscriminately requeue SENT jobs.

## Remaining production release gates

- Live Pages/Worker host, secrets, webhook and owner chat validation; live Telegram receipt delivery has not been exercised.
- PHP syntax/runtime and integration testing in WordPress/WooCommerce, including deletion, failures, token rotation and cron execution.
- Visual browser verification and an end-to-end Telegram Mini App run. No connected browser or PHP interpreter was available in the implementation environment.
- Browser/SMS registration if required, SMS provider selection, resend/attempt limits and recovery design. Phone recycling/account transfer needs a reviewed operator workflow.
- A reviewed migration mapping the current single shop and legacy orders to their verified owner/customer records, if historical orders must appear in the new dashboard.
- Live moderation/support workflow validation, edge abuse controls, storage quotas/monitoring and a published privacy/retention policy before public self-service signup. The application now implements shop approval/suspension, explicit super-admin roles and product quotas.
- Load tests, edge request limits, database storage monitoring, failed-job alerts, backup/restore rehearsal and rollback rehearsal. Receipt BLOBs consume D1 capacity; adopt private object storage if the attachment sizes or marketplace scale exceed this design.
- Inventory/fulfilment rules for physical goods, shipping, refunds, variable products or automatic digital delivery, where the marketplace requires them. This iteration records and reviews direct-transfer orders; it does not reserve WooCommerce inventory or independently verify bank payments.

## Reference contracts

- [Telegram Mini App authentication](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
- [Telegram contact object](https://core.telegram.org/bots/api#contact)
- [D1 transactions through batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [D1 limits, including 2 MB per row](https://developers.cloudflare.com/d1/platform/limits/)
- [WooCommerce APIs](https://developer.woocommerce.com/docs/apis/)
