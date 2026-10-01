const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

function normalizePhone(value) {
  let s = value.replace(/[\s().\-]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;

  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  else if (s.startsWith("0")) {
    // Local format (e.g. 012 345 678): needs a default country code to resolve
    const cc = process.env.DEFAULT_PHONE_COUNTRY_CODE; // e.g. "855"
    if (!cc) return null;
    s = cc + s.slice(1);
  }

  return /^[1-9]\d{7,14}$/.test(s) ? s : null; // E.164: max 15 digits
}

function parseTelegramContact(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return null;

  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw value if it isn't valid percent-encoding */
  }

  // tg://resolve?domain=name or tg://resolve?phone=123
  const tgDomain = value.match(/^tg:\/\/resolve\?(?:.*&)?domain=([^&]+)/i);
  if (tgDomain) value = tgDomain[1];
  const tgPhone = value.match(/^tg:\/\/resolve\?(?:.*&)?phone=([^&]+)/i);
  if (tgPhone) value = `+${tgPhone[1].replace(/^\+/, "")}`;

  // https://t.me/..., http://telegram.me/..., t.me/..., telegram.dog/...
  value = value
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)\//i, "")
    .split(/[?#]/)[0]
    .replace(/\/+$/, "")
    .replace(/^@/, "")
    .trim();

  if (USERNAME_RE.test(value)) return { type: "username", value };

  const phone = normalizePhone(value);
  if (phone) return { type: "phone", value: phone };

  return null;
}

function merchantChatUrl(booking) {
  const contact = parseTelegramContact(booking.merchant_telegram);
  if (contact?.type === "username") return `https://t.me/${contact.value}`;
  if (contact?.type === "phone") return `https://t.me/+${contact.value}`;

  const id = Number(booking.merchant_chat_id ?? booking.merchant_telegram_chat_id);
  if (Number.isFinite(id) && id > 0) return `tg://user?id=${id}`; // private chat only

  return null;
}

function buildBookingKeyboard(booking, { noMessage = false } = {}) {
  const rows = [];
  const chatUrl = noMessage ? null : merchantChatUrl(booking);
  console.log("merchantChatUrl:", chatUrl, booking.merchant_telegram, booking.merchant_chat_id);

  if (chatUrl) {
    rows.push([{ text: `💬 Message ${booking.business_name || "the business"}`, url: chatUrl }]);
  }
  rows.push([
    { text: "📋 View booking", url: `https://acmereserve.com/my-bookings/${booking.id}` },
  ]);

  return { inline_keyboard: rows };
}

module.exports = { buildBookingKeyboard, merchantChatUrl };