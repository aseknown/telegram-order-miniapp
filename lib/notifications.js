export async function deliverNotifications(env, limit = 5) {
  if (!env.BOT_TOKEN || !env.DB) return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(now).run();
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at<?').bind(now).run();
  const { results } = await env.DB.prepare(`SELECT id FROM notifications
    WHERE (state='PENDING' AND next_attempt<=?) OR (state='SENDING' AND lease_until<?)
    ORDER BY next_attempt LIMIT ?`).bind(now, now, limit).all();
  for (const candidate of results) {
    const lease = crypto.randomUUID();
    const job = await env.DB.prepare(`UPDATE notifications SET state='SENDING',lease=?,lease_until=?,attempts=attempts+1
      WHERE id=? AND ((state='PENDING' AND next_attempt<=?) OR (state='SENDING' AND lease_until<?)) RETURNING *`)
      .bind(lease, now + 120, candidate.id, now, now).first();
    if (!job) continue;
    try {
      let method = 'sendMessage';
      let body;
      if (job.attachment_id) {
        const file = await env.DB.prepare('SELECT mime,content FROM attachments WHERE id=?').bind(job.attachment_id).first();
        if (!file) throw new Error('ATTACHMENT_MISSING');
        body = new FormData();
        body.append('chat_id', job.recipient);
        // Documents preserve the receipt bytes instead of Telegram photo recompression.
        body.append('document', new Blob([new Uint8Array(file.content)], { type: file.mime }), 'receipt.' + ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file.mime]));
        body.append('caption', job.message);
        method = 'sendDocument';
      } else {
        body = new FormData();
        body.append('chat_id', job.recipient);
        body.append('text', job.message);
      }
      const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: 'POST', body, signal: AbortSignal.timeout(15000)
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(`TELEGRAM_${result.error_code || response.status}`);
      await env.DB.prepare("UPDATE notifications SET state='SENT',telegram_message_id=?,error_code=NULL WHERE id=? AND lease=?")
        .bind(result.result.message_id, job.id, lease).run();
    } catch (error) {
      const code = /^TELEGRAM_\d+$/.test(error.message) ? error.message : 'DELIVERY_FAILED';
      await env.DB.prepare('UPDATE notifications SET state=?,next_attempt=?,error_code=? WHERE id=? AND lease=?')
        .bind(job.attempts >= 8 ? 'FAILED' : 'PENDING', now + Math.min(3600, 15 * 2 ** job.attempts), code, job.id, lease).run();
    }
  }
}
