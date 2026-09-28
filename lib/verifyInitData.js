const crypto = require("crypto");


const CUSTOMER_BOT_TOKEN = process.env.ACME_RESERVE_CUSTOMER_BOT_TOKEN;

function verifyInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const age = Date.now() / 1000 - Number(params.get("auth_date"));

  // TEMP DEBUG
  console.log({
    tokenLoaded: !!botToken,
    tokenPrefix: botToken?.split(":")[0], // bot ID, safe to log
    hashMatches: calculated === hash,
    ageSeconds: Math.round(age),
  });

  if (calculated !== hash || age >= maxAgeSeconds) return null;
  return JSON.parse(params.get("user"));
}

function getVerifiedTelegramUser(initData) {
  if (!initData) return null;
  try {
    const user = verifyInitData(initData, CUSTOMER_BOT_TOKEN);
    if (!user) console.warn('booking/create: telegramInitData failed verification');
    return user;
  } catch (err) {
    console.warn('booking/create: could not parse telegramInitData', err);
    return null;
  }
}

async function sendCustomerReceipt(chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${CUSTOMER_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!r.ok) {
      console.warn('Customer receipt not delivered:', r.status, await r.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Customer receipt error:', err);
    return false;
  }
}

module.exports = {verifyInitData, sendCustomerReceipt, getVerifiedTelegramUser}