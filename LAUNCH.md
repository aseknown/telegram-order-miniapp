# Launch status

The local implementation is ready for deployment testing. It is **not yet a verified live launch**.

## Evidence from this session

- 34 automated tests pass, covering tenant isolation, quotas, public visibility, filtering, revocable sessions, permissions and stale responses.
- Cloudflare Functions compile; all four migrations apply to an isolated local D1 database.
- Cloudflare confirms `telegram-order-shop.pages.dev` belongs to the `telegram-order-shop` Pages project. `PUBLIC_URL` now uses this address.
- The old `telegram-order-miniapp.hosseinsam72.workers.dev` URL returns HTML instead of the expected JSON API.
- The production Pages secret listing returned **no configured secrets**. The bot token and webhook secret must be set before launch. No secret values were read.
- Public checks against the confirmed Pages address timed out from this environment. Reachability and live operation remain unverified.
- No production migration, role grant, webhook change, commit or deployment was performed.

## Operator sequence

1. Back up D1 and verify the backup. Confirm both Wrangler files reference the intended database. Use a staging bot to exercise the full flow before inviting paying customers.
2. Configure production secrets using Wrangler's hidden terminal prompts; do not paste credentials into chat or source:

   ```powershell
   npx.cmd wrangler pages secret put BOT_TOKEN --project-name=telegram-order-shop
   npx.cmd wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name=telegram-order-shop
   ```

   Generate a random webhook secret and use that same value when registering the webhook.
3. When ready, test, migrate and deploy the app plus notification scheduler:

   ```powershell
   npm.cmd test
   npm.cmd run build:check
   npm.cmd run db:remote
   npm.cmd run deploy
   npm.cmd run notifications:deploy
   npx.cmd wrangler secret put BOT_TOKEN --config wrangler.notifications.toml
   ```
a
   Pages and the scheduler use the same bot but separate secret stores. Apply all migrations before deploying this frontend. Existing shops become pending after migration 0003; migration 0004 introduces sessions. Check older shop slugs against reserved `/stores`, `/pricing`, `/support` and `/security` paths.
4. Register `https://telegram-order-shop.pages.dev/api/telegram` as the webhook using the matching secret. Open `/start`, share your phone and verify account registration. Grant the intended verified account super-admin access using `npm run admin:manage` (see MARKETPLACE.md).
5. Approve shops, configure paid pricing if desired, and opt selected products into the shared catalog. Complete a real test order: receipt saved, correct seller notified, other seller denied, review completed, customer updated. Verify scheduled retry after a Telegram failure and WooCommerce import/update/archive at the product limit. Check mobile/desktop Telegram layouts, keyboard access and reduced-motion behavior.
6. Run the read-only deployed probes:

   ```powershell
   npm.cmd run launch:check -- --url=https://telegram-order-shop.pages.dev
   ```

   All probes must pass. These verify the API/configuration surface, not bank settlement or Telegram delivery; step 5 is still required.
7. Publish your business identity, real support contact, privacy/retention and refund terms before marketing. Paid access currently uses manually verified payments/grants with expiry, with no automatic charging or renewal.

For a custom domain, connect it to this Pages project, change `PUBLIC_URL`, redeploy, update the webhook and check that exact origin. A separate static Workers deployment will not automatically execute these Pages Functions.

## Behavior and boundaries

- `/` is the shared marketplace; `/stores` is the store directory; `/{username}` is a seller's own store.
- `isPublic` defaults to false. Sellers opt in; WooCommerce sync cannot overwrite their choice. Approval, availability, archiving and subscription quotas still apply.
- Price comparisons across shops require a selected currency. No conversion is implied.
- `/admin` → Permissions grants/removes platform-admin access for verified accounts. Owners and buyers retain record-scoped permissions. The last platform admin cannot be removed.
- `/security` lists and revokes sessions. Tokens stay in page memory. Replayed revoked Telegram proofs cannot recreate access. Duplicate tabs using the exact same signed Telegram launch share that launch's revocation boundary.
- New UI actions cancel/discard old view responses. Already-sent mutations may still commit; order idempotency is enforced in the backend.
- Product cards use typographic artwork. They do not invent product photos or seller claims.
