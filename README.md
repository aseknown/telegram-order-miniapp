# Telegram Manual Order Mini App

A small Telegram store for **4 products** with this workflow:

1. Customer opens the Mini App from your Telegram bot.
2. Customer chooses a product and quantity.
3. The app shows your manual transfer/card details.
4. Customer transfers money outside Telegram.
5. Customer uploads a payment screenshot.
6. Your admin Telegram account receives the screenshot and order details.
7. Support manually checks the bank/card account.
8. Support taps **Attach product link** and sends the delivery URL.
9. Only then does **Accept & Send** become available.
10. Support taps **Accept & Send** and the bot sends the product link to that customer.

There is **no payment gateway and no automatic payment validation**.

## Security model

- The backend validates Telegram Mini App `initData` using Telegram's HMAC signature method before accepting an order.
- The product and total are recalculated on the server. The browser cannot choose its own price.
- Screenshot file size is limited to 8 MB and only JPG/PNG/WEBP is accepted.
- Only `ADMIN_TELEGRAM_ID` can use approval callbacks.
- An order cannot be accepted until a product link has been attached.
- The screenshot is not considered proof of payment. You must verify that money arrived in your real account.
- Never publish a CVV, PIN, banking password, OTP, recovery code, or other authentication secret. Only expose payment information that is safe for customers to use to transfer money to you.

## Files

- `server.js` — API, Telegram bot, manual-review workflow.
- `config.js` — edit your four products and prices.
- `public/index.html` — Telegram Mini App user interface.
- `.env.example` — configuration template.

## 1. Create the Telegram bot

1. Open Telegram and message **@BotFather**.
2. Run `/newbot`.
3. Choose a bot name and username.
4. Copy the bot token.
5. Keep the token secret.

## 2. Get your admin Telegram ID

You can use a temporary value initially, deploy the bot, then message it with `/id` to see your Telegram numeric ID and update `ADMIN_TELEGRAM_ID`.

Alternatively, use any trusted Telegram ID method you already use.

## 3. Edit the products

Open `config.js` and replace the four example products:

```js
{ id: "p1", name: "My Product", price: 25, description: "..." }
```

Keep every `id` unique.

## 4. Create PostgreSQL

The app requires PostgreSQL. Railway, Render, Neon, Supabase, or another PostgreSQL provider will work.

You do **not** have to manually create the tables. The app creates them on startup.

Copy the provider's PostgreSQL connection URL into `DATABASE_URL`.

If your provider requires TLS, set:

```env
PGSSL=true
```

## 5. Deploy — Railway example

Railway is convenient because you can deploy the Node app and add PostgreSQL in the same project.

### A. Put this project on GitHub

Create a new GitHub repository and upload all project files **except your real `.env`**.

### B. Create the Railway service

1. Sign in to Railway.
2. Create a new project from your GitHub repository.
3. Add a PostgreSQL database to the same Railway project.
4. In the app service, add these environment variables:

```env
BOT_TOKEN=your BotFather token
ADMIN_TELEGRAM_ID=your numeric Telegram ID
PUBLIC_URL=https://YOUR-RAILWAY-DOMAIN
DATABASE_URL=your PostgreSQL connection URL
PAYMENT_TITLE=Bank card transfer
CARD_HOLDER=Your Name
CARD_NUMBER=0000 0000 0000 0000
PAYMENT_NOTE=Transfer the exact amount, then upload a screenshot. Your order is delivered only after manual verification.
PGSSL=true
INIT_DATA_MAX_AGE_SECONDS=86400
```

5. In Railway networking/settings, generate a public HTTPS domain.
6. Put that exact HTTPS origin into `PUBLIC_URL`, with no trailing slash.
7. Redeploy after changing `PUBLIC_URL`.

The start command is already defined as:

```bash
npm start
```

### Important note about the bot process

This starter uses Telegram **long polling**, so run only **one application replica/instance**. If you scale to multiple replicas, convert the bot to webhooks first.

## 6. Configure the Mini App in BotFather

Telegram Mini Apps need an HTTPS URL.

Once the deployment has a public HTTPS address, use BotFather to configure the bot's Mini App/menu button to your `PUBLIC_URL`.

Even without the menu button, `/start` and `/shop` in this project send an **Open Shop** Web App button automatically.

## 7. First test

From your customer/test Telegram account:

1. Open your bot.
2. Send `/start`.
3. Tap **Open Shop**.
4. Choose a product.
5. Set quantity.
6. Confirm that your transfer/card details are correct.
7. Upload a test screenshot.
8. Submit.

On the admin Telegram account you should immediately receive the screenshot plus the order.

## 8. Admin approval workflow

### If payment is valid

1. Check your actual bank/card account. Do not approve from the screenshot alone.
2. Tap **🔗 Attach product link**.
3. Send the customer's product/delivery link as your next Telegram message to the bot.
4. The order changes to `READY_TO_SEND`.
5. Tap **✅ Accept & Send**.
6. The bot sends the link to the customer.
7. The order becomes `ACCEPTED`.

### If payment is invalid

Tap **❌ Reject**. The customer receives a rejection/support message and the order becomes `REJECTED`.

## 9. Support/contact behavior

The admin order has a **💬 Contact** button.

- If the customer has a Telegram username, it gives you their `t.me` profile URL.
- If they do not have a public username, you still have their Telegram numeric ID and the bot can send order-status messages to them.

For a larger support system, add a relay mode where messages sent to the bot are forwarded between customer and support. This starter intentionally keeps support simple.

## 10. Test safely before real orders

Before publishing:

- Use fake/test payment details first.
- Test every product.
- Test quantities.
- Test JPG, PNG, and WEBP screenshots.
- Test reject.
- Test attaching a wrong link and then changing it.
- Confirm **Accept & Send** cannot work with no attached link.
- Confirm the correct customer receives the correct link.
- Check mobile layout on Android and iPhone Telegram clients.

## 11. Production improvements worth adding later

- One-time or expiring product links instead of reusable URLs.
- Separate support accounts/roles instead of one `ADMIN_TELEGRAM_ID`.
- Full customer/support message relay.
- Order search and admin dashboard.
- Rate limiting and abuse protection.
- Virus/malware scanning for uploads if you later store arbitrary files.
- Webhooks instead of long polling if you need multiple server instances.
- Automatic backups for PostgreSQL.

## Local development

Create `.env` from `.env.example`, then:

```bash
npm install
npm start
```

For a Telegram Mini App, Telegram must be able to reach the app via HTTPS. For local testing, expose your local port with a trusted HTTPS tunnel and temporarily set `PUBLIC_URL` to that tunnel URL.

Do not commit `.env` or your bot token to GitHub.
