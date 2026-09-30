const express = require("express");
const axios = require("axios");
const router = express.Router();
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken");
const zingoPool = require("../../../database/pgZingo");
const { admin, auth } = require("../../../auth/firebase-admin");
const { normalizePhoneNumber, toFirebaseEmail } = require("../../../lib/normalizePhoneNumber");
const multer = require("multer");
const { uploadMediaFilesToS3, deleteFileFromS3 } = require("../../../database/s3");
const crypto = require("crypto");
const randomHex = crypto.randomBytes(8).toString("hex");
const { getPageForMerchant } = require("../../../lib/getPageForMerchant");
const { UUID_RE } = require("../../../lib/uuidRe");
const { escapeHtml, formatBookingDate, formatBookingTime } = require("../../../lib/formats");
const DEBUG = process.env.TELEGRAM_DEBUG === "1" || process.env.NODE_ENV !== "production";
const dbg = (...args) => { if (DEBUG) console.log("[tg-debug]", ...args); };

const MERCHANT_BOT_TOKEN = process.env.MERCHANT_TELEGRAM_BOT_TOKEN;
const MERCHANT_BOT_USERNAME = process.env.MERCHANT_TELEGRAM_BOT_USERNAME;
const CUSTOMER_BOT_TOKEN = process.env.ACME_RESERVE_CUSTOMER_BOT_TOKEN;

const TELEGRAM_API = `https://api.telegram.org/bot${MERCHANT_BOT_TOKEN}`;
const CUSTOMER_TELEGRAM_API = `https://api.telegram.org/bot${CUSTOMER_BOT_TOKEN}`;





// =============================================================================
// Booking status state machine
//
//   pending ──accept──▶ confirmed ──complete──▶ completed
//      │                    ├──────noshow────▶ no_show
//      └──decline─▶ declined └──────cancel────▶ cancelled
// =============================================================================

// action -> what it does. `from` = statuses the action is allowed from.
// `afterStart` = only allowed once the booking start time has passed.
const STATUS_ACTIONS = {
  accept:   { to: "confirmed", from: ["pending"],   label: "confirm" },
  decline:  { to: "declined",  from: ["pending"],   label: "decline" },
  complete: { to: "completed", from: ["confirmed"], label: "mark completed" },
  noshow:   { to: "no_show",   from: ["confirmed"], label: "mark no show", afterStart: true },
  cancel:   { to: "cancelled", from: ["confirmed"], label: "cancel" },
};

// status -> header text (English / Khmer) + verb used in the footer line
const STATUS_META = {
  confirmed: { en: "✅ Booking confirmed",  km: "✅ បានបញ្ជាក់កក់ទីតាំង",  verb: "Confirmed" },
  declined:  { en: "❌ Booking declined",   km: "❌ បដិសេធការកក់ទីតាំង",    verb: "Declined" },
  completed: { en: "🎉 Booking completed",  km: "🎉 ការកក់បានបញ្ចប់",       verb: "Completed" },
  no_show:   { en: "🚫 No show",            km: "🚫 មិនបានមក",              verb: "Marked as no show" },
  cancelled: { en: "🗑 Booking cancelled",  km: "🗑 ការកក់ត្រូវបានលុបចោល", verb: "Cancelled" },
};

// Buttons shown on a new (pending) request
const PENDING_KEYBOARD = (id) => ({
  inline_keyboard: [
    [
      { text: "✅ Accept", callback_data: `accept:${id}` },
      { text: "❌ Decline", callback_data: `decline:${id}` },
    ],
  ],
});

// Buttons shown after a booking is confirmed
const CONFIRMED_KEYBOARD = (id) => ({
  inline_keyboard: [
    [
      { text: "🎉 Completed", callback_data: `complete:${id}` },
      { text: "🚫 No show", callback_data: `noshow:${id}` },
    ],
    [{ text: "🗑 Cancel booking", callback_data: `cancel:${id}` }],
  ],
});

// Only "pending" and "confirmed" have buttons; everything else is terminal
function keyboardForStatus(status, bookingId) {
  if (status === "pending") return PENDING_KEYBOARD(bookingId);
  if (status === "confirmed") return CONFIRMED_KEYBOARD(bookingId);
  return null;
}

// Replace ONLY the first line of the message with the header for `status`,
// keeping the language (Khmer vs English) of the original header.
function replaceBookingHeader(originalText, status) {
  const meta = STATUS_META[status];
  if (!meta) return originalText;
  const firstLine = originalText.split("\n")[0] || "";
  const isKhmer = /[\u1780-\u17FF]/.test(firstLine);
  return originalText.replace(/^[^\n]*/, isKhmer ? meta.km : meta.en);
}

// Status footer is appended after this separator. We strip it before each
// transition so footers don't pile up.
const FOOTER_SEP = "\n\n──────────";
function stripFooter(text) {
  return text.split(FOOTER_SEP)[0];
}

function formatServiceName(booking) {
  const raw = booking.service_name || booking.service_type_id;
  if (!raw) return null;
  return String(raw).replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function resolveServiceLabel(page, booking) {
  const sections = Array.isArray(page?.sections) ? page.sections : [];
  const serviceTypes = Array.isArray(page?.service_types) ? page.service_types : [];

  const sectionMatch = sections.find((s) =>
    typeof s === "string" ? s === booking.section_id : s.id === booking.section_id
  );
  const sectionName = typeof sectionMatch === "string" ? sectionMatch : sectionMatch?.name ?? "";

  const serviceMatch = serviceTypes.find((s) =>
    typeof s === "string"
      ? s.toLowerCase().replace(/\s+/g, "-") === booking.service_type_id || s === booking.service_type_id
      : s.id === booking.service_type_id
  );
  const serviceName = typeof serviceMatch === "string" ? serviceMatch : serviceMatch?.name ?? "";

  return [sectionName, serviceName].filter(Boolean).join(" · ");
}

function buildMerchantBookingText(booking, header, { requestedAt } = {}) {
  // Prefer the resolved label; fall back to prettifying service_type_id
  const service = booking.service_label || formatServiceName(booking);

  const lines = [
    `<b>${escapeHtml(header)}</b>`,
    requestedAt ? `🕒 Requested on: ${escapeHtml(requestedAt)}` : null,
    "",
    booking.full_name ? `🙋 Name: ${escapeHtml(booking.full_name)}` : null,
    booking.booking_date ? `📅 Date: ${escapeHtml(formatBookingDate(booking.booking_date))}` : null,
    booking.start_time ? `⏰ Time: ${escapeHtml(formatBookingTime(booking.start_time))}` : null,
    service ? `🍽 Service: ${escapeHtml(service)}` : null,
    booking.guests ? `👥 Party size: ${escapeHtml(String(booking.guests))}` : null,
    booking.note ? `📝 Notes: ${escapeHtml(booking.note)}` : null,
    booking.phone ? `📞 Contact: ${escapeHtml(booking.phone)}` : null,
  ];

  return lines.filter((l) => l !== null).join("\n");
}
// Builds the full edited message text (already HTML-escaped, since
// callbackQuery.message.text is plain text and we send with parse_mode HTML).
function buildUpdatedMessage(originalText, status, responderName, booking) {
  const meta = STATUS_META[status];

  // Keep the header language (Khmer vs English) of the original message
  const firstLine = (originalText || "").split("\n")[0] || "";
  const header = /[\u1780-\u17FF]/.test(firstLine) ? meta.km : meta.en;

  const body = buildMerchantBookingText(booking, header);
  const statusLine = `👤 ${escapeHtml(meta.verb)} by ${escapeHtml(responderName || "someone")}`;

  return `${body}${FOOTER_SEP}\n${statusLine}`;
}

// Message sent to the customer's own chat. Returns null when we stay silent.
function buildBookerText(booking) {
  const businessName = escapeHtml(booking.business_name || "the business");

  const dateLine = booking.booking_date
    ? `\n📅 Date: ${escapeHtml(formatBookingDate(booking.booking_date))}`
    : "";
  const timeLine = booking.start_time
    ? `\n⏰ Time: ${escapeHtml(formatBookingTime(booking.start_time))}`
    : "";
  const partyLine = booking.guests ? `\n👥 Party size: ${escapeHtml(String(booking.guests))}` : "";
  const notesLine = booking.note ? `\n📝 Notes: ${escapeHtml(booking.note)}` : "";
  const detailsBlock = `${dateLine}${timeLine}${partyLine}${notesLine}`;

  // merchant_telegram_chat_id is a raw numeric chat id, not a shareable
  // t.me/ link — it only lets *your bot* message that chat server-side.
  // Swap in a real @username or phone number from booking_pages if you
  // have one, for something the booker can actually tap/use.
  const merchantContact = escapeHtml(
    [booking.merchant_telegram, booking.merchant_phone].filter(Boolean).join(" or ") || "the business"
  );
  const trackingLine = `\n\n<a href="${process.env.NEXT_PUBLIC_FRONTEND}/my-bookings/${booking.id}">View your booking here</a>`;

  switch (booking.status) {
    case "confirmed":
      return `✅ <b>Your booking at ${businessName} is confirmed!</b>${detailsBlock}\n\nIf you need to make any changes, please contact the merchant directly at: ${merchantContact}.${trackingLine}`;
    case "declined":
      return `❌ <b>Your booking at ${businessName} was declined.</b>${detailsBlock}\n\nPlease try a different time, or contact the merchant directly if you have questions.${trackingLine}`;
    case "cancelled":
      return `🗑 <b>Your booking at ${businessName} was cancelled by the business.</b>${detailsBlock}\n\nPlease contact the merchant directly at: ${merchantContact} if you have questions.${trackingLine}`;
    case "completed":
      return `🎉 <b>Thanks for visiting ${businessName}!</b>${detailsBlock}${trackingLine}`;
    default:
      return null; // no_show: stay silent
  }
}

// Shared by Telegram + dashboard so the transition rules live in one place.
// Returns the updated booking row, or null if the transition isn't allowed
// (already handled, wrong current status, or too early for no-show).
async function applyBookingStatus(client, { bookingId, action, actorId, actorName, actorLabel }) {
  const cfg = STATUS_ACTIONS[action];
  if (!cfg) return null;

  const startedClause = cfg.afterStart
    ? `AND b.booking_date IS NOT NULL AND b.start_time IS NOT NULL
       AND (b.booking_date + b.start_time) < now()`
    : "";

  const { rows } = await client.query(
    `UPDATE bookings b
     SET status = $1,
         responded_at = now(),
         responded_by_id = $2,
         responded_by_name = $3
     FROM booking_pages bp
     WHERE b.id = $4
       AND b.status = ANY($5)
       AND bp.id = b.booking_page_id
       ${startedClause}
     RETURNING b.*, bp.name AS business_name, bp.telegram AS merchant_telegram, bp.phone AS merchant_phone;`,
    [cfg.to, actorId, actorName, bookingId, cfg.from]
  );

  const booking = rows[0];
  if (!booking) return null;

  await client.query(
    `INSERT INTO booking_events (booking_id, type, payload, actor)
     VALUES ($1, $2, $3, $4);`,
    [booking.id, cfg.to, JSON.stringify(booking), actorLabel || `telegram:${actorId}`]
  );

  return booking;
}

// =============================================================================
// Telegram helpers
// =============================================================================

// Helper to send messages
async function sendTelegramMessage(chatId, text, replyMarkup = null, api = TELEGRAM_API) {
  try {
    return await axios.post(`${api}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (err) {
    console.error("Telegram sendMessage error:", err.response?.data || err.message);
  }
}
async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
  try {
    return await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (err) {
    console.error("Telegram editMessageText error:", err.response?.data || err.message);
  }
}

// Helper function to swap buttons
async function editTelegramReplyMarkup(chatId, messageId, replyMarkup) {
  try {
    return await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  } catch (err) {
    console.error("Telegram editMessageReplyMarkup error:", err.response?.data || err.message);
  }
}

// Helper to answer callback queries (removes button loading spinner)
async function answerCallbackQuery(callbackQueryId, text = "") {
  try {
    return await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
    });
  } catch (err) {
    console.error("Telegram answerCallbackQuery error:", err.response?.data || err.message);
  }
}

// =============================================================================
// Handles every "yes_<action>:<bookingId>" tap (accept, decline, complete,
// noshow, cancel)
// =============================================================================
async function handleBookingStatusCallback(callbackQuery) {
  const callbackId = callbackQuery.id;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const respondedBy = callbackQuery.from.id;
  const responderName = callbackQuery.from.username
    ? `@${callbackQuery.from.username}`
    : callbackQuery.from.first_name;

  const [rawAction, bookingId] = data.split(":");
  const action = rawAction.replace(/^yes_/, ""); // "yes_complete" -> "complete"
  const cfg = STATUS_ACTIONS[action];

  if (!cfg || !UUID_RE.test(bookingId)) {
    await answerCallbackQuery(callbackId, "Invalid action.");
    return;
  }

  const client = await zingoPool.connect();

  try {
    await client.query("BEGIN");

    const booking = await applyBookingStatus(client, {
      bookingId,
      action,
      actorId: respondedBy,
      actorName: responderName,
    });

    if (!booking) {
      await client.query("ROLLBACK");

      // Look up what it actually is now, and sync the message to reality
      const current = await client.query(
        `SELECT b.*, bp.name AS business_name, bp.telegram AS merchant_telegram, bp.phone AS merchant_phone
         FROM bookings b
         JOIN booking_pages bp ON bp.id = b.booking_page_id
         WHERE b.id = $1`,
        [bookingId]
      );
      const b = current.rows[0];

      // The action would have been valid for this status, so it must have been
      // blocked by the "not started yet" rule (no-show).
      const blockedByTime = b && cfg.from.includes(b.status) && cfg.afterStart;
      await answerCallbackQuery(
        callbackId,
        blockedByTime ? "Too early — booking hasn't started yet." : "Already handled."
      );

      if (b) {
        const originalText = callbackQuery.message?.text || "";
        const keyboard = keyboardForStatus(b.status, b.id);

        // Terminal / confirmed states get a synced header + footer.
        // A still-pending booking just gets its original buttons back.
        const text = STATUS_META[b.status]
          ? buildUpdatedMessage(originalText, b.status, b.responded_by_name, b)
          : escapeHtml(stripFooter(originalText));

        // Edit with no replyMarkup → Telegram drops the inline keyboard.
        // For confirmed/pending we pass the right keyboard so buttons don't vanish.
        await editTelegramMessage(chatId, messageId, text, keyboard);
      }
      return; // finally{} still releases the client — no manual release() here
    }

    await client.query("COMMIT");

    await answerCallbackQuery(callbackId, STATUS_META[booking.status].en);

    // Only "confirmed" keeps buttons (Completed / No show / Cancel).
    await editTelegramMessage(
      chatId,
      messageId,
      buildUpdatedMessage(callbackQuery.message?.text || "", booking.status, responderName, booking),
      keyboardForStatus(booking.status, booking.id)
    );

    // Notify the booker (customer) on their own chat, if they've connected Telegram
    if (booking.telegram_chat_id) {
      const bookerText = buildBookerText(booking);
      if (bookerText) {
        await sendTelegramMessage(booking.telegram_chat_id, bookerText, null, CUSTOMER_TELEGRAM_API);
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("handleBookingStatusCallback error:", err);
    await answerCallbackQuery(callbackId, "Something went wrong.");
  } finally {
    client.release();
  }
}

// GET /api/booking-link/booking-notify-status/:bookingId

router.get('/booking-notify-status/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!UUID_RE.test(bookingId)) {
      return res.status(400).json({ error: 'Invalid booking id.' });
    }

    const result = await zingoPool.query(
      `SELECT "telegram_chat_id" FROM "bookings" WHERE "id" = $1`,
      [bookingId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const chatId = result.rows[0].telegram_chat_id;
    return res.status(200).json({ connected: Boolean(chatId) });
  } catch (error) {
    console.error('Error checking booking telegram status:', error);
    return res.status(500).json({ error: 'Failed to check status.' });
  }
});

// PATCH /api/booking-link/bookings/:id/status
// Dashboard equivalent of the Telegram buttons. Body: { action: "complete" | "noshow" | "cancel" | "accept" | "decline" }
router.patch('/bookings/:id/status', authenticateFirebaseToken, async (req, res) => {
  const merchantId = req.user?.id;
  const { id } = req.params;
  const { action } = req.body || {};

  if (!merchantId) return res.status(401).json({ error: 'Unauthorized.' });
  if (!UUID_RE.test(id) || !STATUS_ACTIONS[action]) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const client = await zingoPool.connect();
  try {
    await client.query("BEGIN");

    // Ownership check: the booking must belong to one of this merchant's pages
    const own = await client.query(
      `SELECT 1
       FROM bookings b
       JOIN booking_pages bp ON bp.id = b.booking_page_id
       WHERE b.id = $1 AND bp.merchant_id = $2`,
      [id, merchantId]
    );
    if (own.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = await applyBookingStatus(client, {
      bookingId: id,
      action,
      actorId: merchantId,
      actorName: "Dashboard",
      actorLabel: `dashboard:${merchantId}`,
    });

    if (!booking) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This booking's status can't be changed that way." });
    }

    await client.query("COMMIT");

    // Notify the customer the same way the Telegram flow does
    if (booking.telegram_chat_id) {
      const bookerText = buildBookerText(booking);
      if (bookerText) {
        await sendTelegramMessage(booking.telegram_chat_id, bookerText, null, CUSTOMER_TELEGRAM_API);
      }
    }

    return res.status(200).json({ status: booking.status });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error('Error updating booking status:', error);
    return res.status(500).json({ error: 'Failed to update booking.' });
  } finally {
    client.release();
  }
});

// Create a temporary session
router.post('/booking-settings/telegram-session', authenticateFirebaseToken, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    if (!merchantId) return res.status(401).json({ error: 'Unauthorized.' });

    const token = `sess_${crypto.randomBytes(16).toString('hex')}`;

    await zingoPool.query(
      `INSERT INTO "telegram_link_sessions" ("token", "merchant_id") VALUES ($1, $2)`,
      [token, merchantId]
    );

    const botUsername = process.env.MERCHANT_TELEGRAM_BOT_USERNAME;
    const deepLink = `https://t.me/${botUsername}?start=${token}`;
    // console.log("[tg-debug] deepLink:", deepLink, "| username:", botUsername);

    return res.status(200).json({ token, deepLink });
  } catch (error) {
    console.error('Error creating telegram session:', error);
    return res.status(500).json({ error: 'Failed to create session.' });
  }
});

// Poll the session status
router.get('/booking-settings/telegram-session/:token', authenticateFirebaseToken, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    const { token } = req.params;

    const result = await zingoPool.query(
      `SELECT "chat_id" FROM "telegram_link_sessions" 
       WHERE "token" = $1 AND "merchant_id" = $2 AND "expires_at" > now()`,
      [token, merchantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Session expired or not found.' });
    }

    const chatId = result.rows[0].chat_id;
    return res.status(200).json({
      connected: Boolean(chatId),
      chatId: chatId ? String(chatId) : null,
    });
  } catch (error) {
    console.error('Error polling telegram session:', error);
    return res.status(500).json({ error: 'Failed to check status.' });
  }
});


// Connect telegram
router.post('/booking-settings/:id/telegram-link', authenticateFirebaseToken, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    const pageId = Number(req.params.id);
    if (!Number.isInteger(pageId)) return res.status(400).json({ error: 'Invalid page id.' });

    // Ensure the merchant owns this page
    const page = await getPageForMerchant(pageId, merchantId);
    if (!page) return res.status(404).json({ error: 'Booking page not found.' });

    // Generate a secure, short token (e.g. "page_12_a8f9c1b2")
    const randomHex = crypto.randomBytes(8).toString('hex');
    const token = `page_${pageId}_${randomHex}`;

    await zingoPool.query(
      `UPDATE "booking_pages" SET "telegram_verify_token" = $1 WHERE "id" = $2`,
      [token, pageId]
    );

    const botUsername = process.env.MERCHANT_TELEGRAM_BOT_USERNAME; 
    const deepLink = `https://t.me/${botUsername}?start=${token}`;

    return res.status(200).json({ deepLink });
  } catch (error) {
    console.error('Error creating telegram link:', error);
    return res.status(500).json({ error: 'Failed to generate link.' });
  }
});

// POST /api/telegram-webhook
router.post("/telegram-webhook", async (req, res) => {
   const expected = process.env.MERCHANT_TELEGRAM_WEBHOOK_SERCRET;
  if (expected && req.get("X-Telegram-Bot-Api-Secret-Token") !== expected) {
    console.warn("[tg-debug] webhook rejected: bad secret token");
    return res.sendStatus(403);
  }
  // Always return 200 OK immediately so Telegram doesn't retry delivery
  res.sendStatus(200);

  const { message, callback_query } = req.body || {};
  const dashboardUrl = "https://acmereserve.com";
  const botUsername = process.env.MERHCHANT_TELEGRAM__BOT_USERNAME;

  // =========================================================================
  // 1. User clicked a deep link and launched /start <token> (or /start@Bot <token>
  //    in a group, via a startgroup= link)
  //    Token prefixes: sess_ (merchant, unsaved page) | bk_ (customer, anon_id)
  //    pg_ (merchant, existing saved page)
  // =========================================================================
  if (message && message.text) {
    // Matches "/start", "/start TOKEN", "/start@BotName", "/start@BotName TOKEN"
    const startMatch = message.text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);

    if (startMatch) {
      const chatId = message.chat.id;
      const chatType = message.chat.type; // "private" | "group" | "supergroup" | "channel"
      const senderName = message.from?.first_name || "there";
      const username = message.from?.username ? `@${message.from.username}` : senderName;
      const rawToken = startMatch[1]?.trim();

      if (!rawToken) return;

      const isGroupChat = chatType === "group" || chatType === "supergroup";

      try {
        // --- Case A: Merchant, unsaved/session-based page creation ---
        if (rawToken.startsWith("sess_")) {
          const sessionRes = await zingoPool.query(
            `SELECT "merchant_id" FROM "telegram_link_sessions"
             WHERE "token" = $1 AND "expires_at" > now() LIMIT 1`,
            [rawToken]
          );

          if (sessionRes.rowCount === 0) {
            await sendTelegramMessage(
              chatId,
              "⚠️ This connection session has expired or is invalid. Please click *Verify & Connect Telegram* again on your dashboard."
            );
            return;
          }

          // Group chats: arriving here means the merchant already picked a group
          // via the "Connect to a Group" URL button — that action IS the confirmation,
          // no callback button needed.
          if (isGroupChat) {
            const updateSession = await zingoPool.query(
              `UPDATE "telegram_link_sessions"
               SET "chat_id" = $1
               WHERE "token" = $2 AND "expires_at" > now()
               RETURNING "merchant_id"`,
              [chatId, rawToken]
            );

            if (updateSession.rowCount > 0) {
              await sendTelegramMessage(
                chatId,
                `✅ <b>Group connected!</b>\n\nBooking requests will be sent to this group from now on.`
              );
            } else {
              await sendTelegramMessage(
                chatId,
                "⚠️ This session has expired. Please click *Verify & Connect Telegram* on your dashboard again."
              );
            }
            return;
          }

          // Private chat: show confirm / switch-account / connect-to-group options
          const groupDeepLink = `https://t.me/${botUsername}?startgroup=${rawToken}`;
          const keyboard = {
            inline_keyboard: [
              [{ text: `✅ Connect as ${username}`, callback_data: `confirm_tg:${rawToken}` }],
              [{ text: "👥 Connect to a Group instead", url: groupDeepLink }],
              [{ text: "🔄 Switch Telegram Account", callback_data: "switch_account" }],
            ],
          };

          const safeSender = escapeHtml(senderName);
          await sendTelegramMessage(
            chatId,
            `Hello <b>${safeSender}</b>!\n\nDo you want to connect this Telegram account to receive instant booking notifications for:\n\n🏬 <b>your booking page</b>`,
            keyboard
          );
          return;
        }

        // --- Case B: Merchant, existing saved page ---
        if (rawToken.startsWith("pg_")) {
          const pageToken = rawToken.replace("pg_", "");
          const pageRes = await zingoPool.query(
            `SELECT "name" FROM "booking_pages" WHERE "telegram_verify_token" = $1 LIMIT 1`,
            [pageToken]
          );

          if (pageRes.rowCount === 0) {
            await sendTelegramMessage(
              chatId,
              "⚠️ This connection link has already expired or been used. Please generate a new one from your dashboard."
            );
            return;
          }

          const businessLabel = escapeHtml(pageRes.rows[0].name);

          // Group chats: same as above — picking the group via the URL button
          // is the confirmation, save immediately.
          if (isGroupChat) {
            const updatePage = await zingoPool.query(
              `UPDATE "booking_pages"
               SET "telegram_chat_id" = $1, "telegram_verify_token" = NULL
               WHERE "telegram_verify_token" = $2
               RETURNING "name"`,
              [chatId, pageToken]
            );

            if (updatePage.rowCount > 0) {
              await sendTelegramMessage(
                chatId,
                `✅ <b>Group connected!</b>\n\nThis group will now receive new booking requests for <b>${businessLabel}</b>.`
              );
            } else {
              await sendTelegramMessage(
                chatId,
                "⚠️ This link has already been used or expired. Please generate a new one from your dashboard."
              );
            }
            return;
          }

          const groupDeepLink = `https://t.me/${botUsername}?startgroup=${rawToken}`;
          console.log("Group DeepLink", groupDeepLink)
          const keyboard = {
            inline_keyboard: [
              [{ text: `✅ Connect as ${username}`, callback_data: `confirm_tg:${rawToken}` }],
              [{ text: "👥 Connect to a Group instead", url: groupDeepLink }],
              [{ text: "🔄 Switch Telegram Account", callback_data: "switch_account" }],
            ],
          };

          const safeSender = escapeHtml(senderName);
          await sendTelegramMessage(
            chatId,
            `Hello <b>${safeSender}</b>!\n\nDo you want to connect this Telegram account to receive instant booking notifications for:\n\n🏬 <b>${businessLabel}</b>`,
            keyboard
          );
          return;
        }

        // --- Case C: Customer, connect this chat to their anon_id ---
        if (rawToken.startsWith("bk_")) {
          const bookingId = rawToken.replace("bk_", "").trim();

          if (!UUID_RE.test(bookingId)) {
            await sendTelegramMessage(chatId, "⚠️ That link isn't valid. Please try again from the website.");
            return;
          }

          const result = await zingoPool.query(
            `UPDATE bookings b
            SET telegram_chat_id = $1
            FROM booking_pages bp
            WHERE b.id = $2 AND bp.id = b.booking_page_id
            RETURNING b.id, bp.name AS business_name`,
            [chatId, bookingId]
          );

          if (result.rowCount === 0) {
            await sendTelegramMessage(chatId, "⚠️ We couldn't find that booking. Please try again from the website.");
            return;
          }

          const businessName = escapeHtml(result.rows[0].business_name);
          await sendTelegramMessage(
            chatId,
            `✅ You're set — we'll message you here as soon as your booking at <b>${businessName}</b> is confirmed.\nOr <a href="${process.env.NEXT_PUBLIC_FRONTEND}/my-bookings/${bookingId}">view your booking here</a>`
          );
          return;
        }

        // Unknown token shape
        await sendTelegramMessage(chatId, "⚠️ That link isn't valid. Please try again from the website.");
      } catch (err) {
        console.error("Error processing /start command:", err);
      }
      return;
    }
  }

  // =========================================================================
  // 2. User tapped an inline button
  // =========================================================================
  if (callback_query) {
    const callbackId = callback_query.id;
    const data = callback_query.data;
    const chatId = callback_query.message.chat.id;
    const messageId = callback_query.message.message_id;

    // --- Booking status actions (merchant side) ---------------------------
    // accept / decline / complete / noshow / cancel

    // Step 1: tapped an action button -> ask "are you sure?"
    {
      const [action, bookingId] = data.split(":");
      const cfg = STATUS_ACTIONS[action];

      if (cfg) {
        if (!UUID_RE.test(bookingId)) {
          await answerCallbackQuery(callbackId, "Invalid action.");
          return;
        }

        await answerCallbackQuery(callbackId, `Sure you want to ${cfg.label}?`);
        await editTelegramReplyMarkup(chatId, messageId, {
          inline_keyboard: [
            [
              { text: `Yes, ${cfg.label}`, callback_data: `yes_${action}:${bookingId}` },
              // "back_pending" or "back_confirmed" → restores the right keyboard
              { text: "↩️ Back", callback_data: `back_${cfg.from[0]}:${bookingId}` },
            ],
          ],
        });
        return;
      }
    }

    // Step 2: user confirmed -> actually do it
    if (data.startsWith("yes_")) {
      await handleBookingStatusCallback(callback_query);
      return;
    }

    // Back: restore the original buttons for that state.
    // Plain "back:" is kept so messages sent before this update still work.
    if (data.startsWith("back_pending:") || data.startsWith("back_confirmed:") || data.startsWith("back:")) {
      const [key, bookingId] = data.split(":");

      if (!UUID_RE.test(bookingId)) {
        await answerCallbackQuery(callbackId, "Invalid action.");
        return;
      }

      await answerCallbackQuery(callbackId);
      await editTelegramReplyMarkup(
        chatId,
        messageId,
        key === "back_confirmed" ? CONFIRMED_KEYBOARD(bookingId) : PENDING_KEYBOARD(bookingId)
      );
      return;
    }

    // --- Action: Merchant confirms account connection (sess_ or pg_) ---
    if (data.startsWith("confirm_tg:")) {
      const rawToken = data.replace("confirm_tg:", "").trim();

      try {
        if (rawToken.startsWith("sess_")) {
          const updateSession = await zingoPool.query(
            `UPDATE "telegram_link_sessions"
             SET "chat_id" = $1
             WHERE "token" = $2 AND "expires_at" > now()
             RETURNING "merchant_id"`,
            [chatId, rawToken]
          );

          if (updateSession.rowCount > 0) {
            await answerCallbackQuery(callbackId, "Account connected successfully!");
            await editTelegramMessage(
              chatId,
              messageId,
              `*Account Connected!*\n\nYou're all set. You can now return to your browser and finish saving your booking page.`,
              { inline_keyboard: [[{ text: "↩️ Return to dashboard", url: dashboardUrl }]] }
            );
          } else {
            await answerCallbackQuery(callbackId, "Session expired.");
            await editTelegramMessage(
              chatId,
              messageId,
              "⚠️ This session has expired. Please click *Verify & Connect Telegram* on your dashboard again."
            );
          }
          return;
        }

        if (rawToken.startsWith("pg_")) {
          const pageToken = rawToken.replace("pg_", "");
          const updatePage = await zingoPool.query(
            `UPDATE "booking_pages"
             SET "telegram_chat_id" = $1, "telegram_verify_token" = NULL
             WHERE "telegram_verify_token" = $2
             RETURNING "name"`,
            [chatId, pageToken]
          );

          if (updatePage.rowCount > 0) {
            const pageName = updatePage.rows[0].name;
            await answerCallbackQuery(callbackId, "Connected!");
            await editTelegramMessage(
              chatId,
              messageId,
              `*Connected successfully!*\n\nThis Telegram account will now receive new booking requests for *${pageName}*.`,
              { inline_keyboard: [[{ text: "↩️ Return to dashboard", url: dashboardUrl }]] }
            );
          } else {
            await answerCallbackQuery(callbackId, "Link already used.");
            await editTelegramMessage(
              chatId,
              messageId,
              "⚠️ This link has already been used or expired. Please generate a new link in your dashboard."
            );
          }
          return;
        }

        // Unknown token shape reaching confirm_tg
        await answerCallbackQuery(callbackId, "Invalid link.");
      } catch (err) {
        console.error("Error confirming Telegram connection:", err);
        await answerCallbackQuery(callbackId, "Error connecting account.");
      }
      return;
    }

    // --- Action: Customer confirms notification chat (anon_id -> telegram_contacts) ---
    if (data.startsWith("confirm_bk:")) {
      const bookingId = data.replace("confirm_bk:", "").trim();

      try {
        const result = await zingoPool.query(
          `UPDATE bookings
          SET telegram_chat_id = $1
          WHERE id = $2
          RETURNING id`,
          [chatId, bookingId]
        );

        if (result.rowCount > 0) {
          await answerCallbackQuery(callbackId, "Connected!");
          await editTelegramMessage(
            chatId,
            messageId,
            `You're all set — we'll message you here as soon as your booking is confirmed. Your booking ID: ${bookingId}`
          );
        } else {
          await answerCallbackQuery(callbackId, "Booking not found.");
          await editTelegramMessage(chatId, messageId, "⚠️ We couldn't find that booking.");
        }
      } catch (err) {
        console.error("Error confirming booking chat link:", err);
        await answerCallbackQuery(callbackId, "Error connecting.");
      }
      return;
    }

    // --- Action: Switch / Change Account (merchant flow) ---
    if (data === "switch_account") {
      await answerCallbackQuery(callbackId);
      await editTelegramMessage(
        chatId,
        messageId,
        `ℹ️ *To connect a different Telegram account:*\n\n1. Switch to your other Telegram account on this device or desktop.\n2. Return to your web dashboard.\n3. Click *Verify & Connect Telegram* again to open this bot from that account.`
      );
      return;
    }
  }
});

// POST /booking-settings/:id/telegram-disconnect
router.post('/booking-settings/:id/telegram-disconnect', authenticateFirebaseToken, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    const pageId = Number(req.params.id);

    await zingoPool.query(
      `UPDATE "booking_pages" 
       SET "telegram_chat_id" = NULL, "telegram_verify_token" = NULL 
       WHERE "id" = $1 AND "merchant_id" = $2`,
      [pageId, merchantId]
    );

    return res.status(200).json({ message: 'Telegram disconnected.' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to disconnect.' });
  }
});


module.exports = router;

module.exports.resolveServiceLabel = resolveServiceLabel;
module.exports.buildMerchantBookingText = buildMerchantBookingText;
module.exports.PENDING_KEYBOARD = PENDING_KEYBOARD;