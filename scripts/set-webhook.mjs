const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in the current shell first.`);
  return value;
};

const token = required('BOT_TOKEN');
const secret = required('TELEGRAM_WEBHOOK_SECRET');
const publicUrl = required('PUBLIC_URL').replace(/\/$/, '');
if (!/^https:\/\//i.test(publicUrl)) throw new Error('PUBLIC_URL must start with https://');

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(`${method} failed: ${result.description || response.status}`);
  return result;
}

const webhookUrl = `${publicUrl}/api/telegram`;
await telegram('setWebhook', {
  url: webhookUrl,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query']
});
await telegram('setMyCommands', {
  commands: [
    {command: 'start', description: 'Open the marketplace'},
    {command: 'phone', description: 'Verify your phone number'}
  ]
});
const info = await telegram('getWebhookInfo', {});
console.log(JSON.stringify({ok: true, webhook: info.result}, null, 2));
