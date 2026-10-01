const axios = require("axios");
const zingoPool = require("../database/pgZingo");
const { escapeHtml, formatBookingDate, formatBookingTime } = require("../lib/formats");
const { buildBookingKeyboard } = require("../lib/bookingKeyboard");

const CUSTOMER_BOT_TOKEN = process.env.ACME_RESERVE_CUSTOMER_BOT_TOKEN;
const CUSTOMER_TELEGRAM_API = `https://api.telegram.org/bot${CUSTOMER_BOT_TOKEN}`;

const BUSINESS_TZ = "Asia/Phnom_Penh";
const QUIET_START_HOUR = 21; // 9pm
const QUIET_END_HOUR = 8;    // 8am
const SHORT_NOTICE_HOURS = 48; // booked with <= this much lead time = "short notice"


// column = flag column to set, leadMinutes = how far ahead to remind,
// minLeadMinutes = don't send if the booking is closer than this
const REMINDERS = [
  { key: "24h", column: "reminder_24h_sent_at", leadMinutes: 1440, minLeadMinutes: 180, requireConfirmedEarly: true,  notice: "long" },
  { key: "12h", column: "reminder_12h_sent_at", leadMinutes: 720,  minLeadMinutes: 180, requireConfirmedEarly: true,  notice: "short" },
  { key: "2h",  column: "reminder_sent_at",     leadMinutes: 120,  minLeadMinutes: 0,   requireConfirmedEarly: false, notice: "any" },
];
function isQuietHours() {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: BUSINESS_TZ,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date())
  );
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

function merchantChatUrl(booking) {
  const handle = String(booking.merchant_telegram || "")
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "");
  if (/^[A-Za-z0-9_]{5,32}$/.test(handle)) return `https://t.me/${handle}`;

  const id = Number(booking.merchant_chat_id);
  if (Number.isFinite(id) && id > 0) return `tg://user?id=${id}`; // private chat only

  return null;
}



function buildReminderText(booking, key) {
  const businessName = escapeHtml(booking.business_name || "the business");
  const date = escapeHtml(formatBookingDate(booking.booking_date));
  const time = escapeHtml(formatBookingTime(booking.start_time));
  const partyLine = booking.guests
    ? `\n👥 Party size: ${escapeHtml(String(booking.guests))}`
    : "";

const header =
  key === "2h"
    ? `⏰ <b>Reminder: your booking at ${businessName} is today!</b>`
    : `⏰ <b>Reminder: you have a booking at ${businessName} coming up</b>`;

const footer = key === "2h" ? "" : `\n\nPlans changed? Message the business below.`;



  return `${header}\n\n📅 ${date}\n🕒 ${time}${partyLine}${footer}`;
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const post = (markup) =>
    axios.post(`${CUSTOMER_TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(markup ? { reply_markup: markup } : {}),
    });

  try {
    await post(replyMarkup);
  } catch (err) {
    console.error("[reminders] send failed:", err.response?.data || err.message);

    // Bad button URL etc. → retry once without the keyboard
    if (replyMarkup && err.response?.status === 400) {
      try {
        await post(null);
      } catch (err2) {
        console.error("[reminders] retry failed:", err2.response?.data || err2.message);
      }
    }
  }
}

async function sendRemindersFor({ key, column, leadMinutes, minLeadMinutes, requireConfirmedEarly, notice }) {
  // `column` and the notice clause come from constants above, never from user input
  const confirmedEarlyClause = requireConfirmedEarly
    ? `AND responded_at IS NOT NULL
       AND responded_at < ((booking_date + start_time) AT TIME ZONE $2) - make_interval(mins => $1)`
    : "";

  const leadTime = `(((booking_date + start_time) AT TIME ZONE $2) - created_at)`;
  const noticeClause =
    notice === "long"
      ? `AND ${leadTime} > interval '${SHORT_NOTICE_HOURS} hours'`
      : notice === "short"
      ? `AND ${leadTime} <= interval '${SHORT_NOTICE_HOURS} hours'`
      : "";

  const { rows } = await zingoPool.query(
    `UPDATE bookings b
     SET ${column} = now()
     FROM booking_pages bp
     WHERE bp.id = b.booking_page_id
       AND b.id IN (
         SELECT id FROM bookings
         WHERE status = 'confirmed'
           AND telegram_chat_id IS NOT NULL
           AND ${column} IS NULL
           AND booking_date IS NOT NULL
           AND start_time IS NOT NULL
           AND ((booking_date + start_time) AT TIME ZONE $2) > now() + make_interval(mins => $3)
           AND ((booking_date + start_time) AT TIME ZONE $2) <= now() + make_interval(mins => $1)
           ${noticeClause}
           ${confirmedEarlyClause}
         FOR UPDATE SKIP LOCKED
       )
       RETURNING b.*,
               bp.name AS business_name,
               bp.telegram AS merchant_telegram,
               bp.telegram_chat_id AS merchant_chat_id;`,
    [leadMinutes, BUSINESS_TZ, minLeadMinutes]
  );

  for (const booking of rows) {
    await sendMessage(
      booking.telegram_chat_id,
      buildReminderText(booking, key),
      buildBookingKeyboard(booking)
    );
  }
  if (rows.length) console.log(`[reminders] ${key}: sent ${rows.length}`);
}

async function sendBookingReminders() {
  if (isQuietHours()) return; // held until 8am; nothing is lost

  for (const reminder of REMINDERS) {
    await sendRemindersFor(reminder);
  }
}

module.exports = { sendBookingReminders };
