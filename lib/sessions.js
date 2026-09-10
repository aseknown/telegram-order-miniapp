const encoder=new TextEncoder();
export async function sessionToken(proof,botToken) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(botToken),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode('shopline-session\n'+proof)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function issueSession(context,validate,{digest,json,ApiError}) {
  const {env,request}=context;
  if(!env.BOT_TOKEN) throw new ApiError(503,'Sign-in is unavailable until the bot is configured.');
  const header=request.headers.get('authorization') || '';
  if(!header.startsWith('Telegram ') || header.length>16384) throw new ApiError(401,'Open this app in Telegram to sign in.');
  const proof=header.slice(9); const auth=await validate(proof,env.BOT_TOKEN);
  if(!auth.ok || !Number.isSafeInteger(auth.user?.id) || auth.user.id<=0) throw new ApiError(401,'Telegram authentication failed. Reopen the app.');
  const user=await env.DB.prepare('SELECT id FROM customers WHERE telegram_id=?').bind(String(auth.user.id)).first();
  if(!user) return json({needsPhone:true,telegramName:auth.user.first_name});
  const proofHash=await digest(proof); const token=await sessionToken(proof,env.BOT_TOKEN);
  const created=Math.floor(Date.now()/1000); const expires=Number(new URLSearchParams(proof).get('auth_date'))+3600;
  await env.DB.prepare(`INSERT INTO auth_sessions (id,customer_id,proof_hash,token_hash,label,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(proof_hash) DO NOTHING`).bind(crypto.randomUUID(),user.id,proofHash,await digest(token),(request.headers.get('user-agent') || 'Telegram client').slice(0,160),created,expires).run();
  const session=await env.DB.prepare('SELECT id,customer_id,expires_at,revoked_at FROM auth_sessions WHERE proof_hash=?').bind(proofHash).first();
  if(session.customer_id!==user.id || session.revoked_at || session.expires_at<=created) throw new ApiError(401,'This session has ended. Close and reopen the app from Telegram.');
  return json({token,sessionId:session.id,expiresAt:session.expires_at});
}
