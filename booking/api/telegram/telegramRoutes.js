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


const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
console.log("Checking Token:", process.env.TELEGRAM_BOT_TOKEN ? "EXISTS" : "UNDEFINED");
console.log("Full Request URL:", `${TELEGRAM_API}/sendMessage`);
// Helper to send messages
async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  try {
    return await axios.post(`${TELEGRAM_API}/sendMessage`, {
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
      parse_mode: "Markdown",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (err) {
    console.error("Telegram editMessageText error:", err.response?.data || err.message);
  }
}


// Helper to answer callback queries (removes button loading spinner)
async function answerCallbackQuery(callbackQueryId, text = "") {
  return axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    text,
  });
}

// -----------------------------------------------------------------------
// Upsert a telegram_contacts row once a customer connects a chat_id.
//
// telegram_contacts has NO unique constraint on chat_id itself — only on
// phone_number and anon_id (both partial/nullable). So we have to pick one
// of those as the conflict target. Bookings always collect a phone number,
// so that's the primary key we upsert on; anon_id is a fallback for the
// (currently unused here) case where a booking has no phone but does carry
// an anon_id. If neither is available we skip linking rather than insert
// an unkeyed, unmatchable row.
// -----------------------------------------------------------------------
async function linkTelegramContact({ chatId, phoneNumber, anonId = null, username = null }) {
  const normalizedPhone = phoneNumber ? normalizePhoneNumber(phoneNumber) : null;

  if (!normalizedPhone && !anonId) {
    console.warn("linkTelegramContact: no phone or anon_id to key off of, skipping.", { chatId });
    return;
  }

  try {
    if (normalizedPhone) {
      await zingoPool.query(
        `INSERT INTO telegram_contacts (anon_id, phone_number, chat_id, telegram_username, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (phone_number) WHERE phone_number IS NOT NULL
         DO UPDATE SET
           chat_id = EXCLUDED.chat_id,
           telegram_username = EXCLUDED.telegram_username,
           anon_id = COALESCE(telegram_contacts.anon_id, EXCLUDED.anon_id),
           updated_at = now();`,
        [anonId, normalizedPhone, chatId, username]
      );
    } else {
      await zingoPool.query(
        `INSERT INTO telegram_contacts (anon_id, phone_number, chat_id, telegram_username, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (anon_id) WHERE anon_id IS NOT NULL
         DO UPDATE SET
           chat_id = EXCLUDED.chat_id,
           telegram_username = EXCLUDED.telegram_username,
           updated_at = now();`,
        [anonId, normalizedPhone, chatId, username]
      );
    }
  } catch (err) {
    // A failed contact-link should never take down the booking confirmation
    // flow — the bookings.telegram_chat_id update is the source of truth.
    console.error("linkTelegramContact error:", err);
  }
}

async function handleBookingStatusCallback(callbackQuery) {
  const callbackId = callbackQuery.id;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const respondedBy = callbackQuery.from.id;

  const [action, bookingId] = data.split(":");

  if (!["accept", "decline"].includes(action) || !UUID_RE.test(bookingId)) {
    await answerCallbackQuery(callbackId, "Invalid action.");
    return;
  }

  const newStatus = action === "accept" ? "confirmed" : "declined";
  const client = await zingoPool.connect();

  try {
    await client.query("BEGIN");

    const updateResult = await client.query(
      `UPDATE bookings
       SET status = $1,
           responded_at = now(),
           responded_by_id = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING *;`,
      [newStatus, respondedBy, bookingId]
    );

    const booking = updateResult.rows[0];

    if (!booking) {
      await client.query("ROLLBACK");
      await answerCallbackQuery(callbackId, "Already handled.");
      client.release();
      return;
    }

    await client.query(
      `INSERT INTO booking_events (booking_id, type, payload, actor)
       VALUES ($1, $2, $3, $4);`,
      [booking.id, newStatus, JSON.stringify(booking), `telegram:${respondedBy}`]
    );

    await client.query("COMMIT");

    await answerCallbackQuery(
      callbackId,
      newStatus === "confirmed" ? "Booking confirmed ✅" : "Booking declined ❌"
    );

    // --- Update the merchant's message ---
    const originalText = callbackQuery.message?.text || "";
    const responderName = callbackQuery.from.username
      ? `@${callbackQuery.from.username}`
      : callbackQuery.from.first_name;
    const statusLine =
      newStatus === "confirmed"
        ? `✅ Confirmed by ${responderName}`
        : `❌ Declined by ${responderName}`;

    // Phone number stays as a fallback whether or not the booker connected
    // Telegram — auto-linkified on mobile for tap-to-call/text.
    const contactLine = booking.phone
      ? `\n📱 ${booking.full_name}: ${booking.phone}`
      : "";

    await editTelegramMessage(chatId, messageId, `${originalText}\n\n${statusLine}${contactLine}`);

    // --- Notify the booker directly, only if they connected Telegram ---
    if (booking.telegram_chat_id) {
      const bookerText =
        newStatus === "confirmed"
          ? `✅ Your booking is confirmed!\n\n${booking.booking_date} at ${booking.start_time}`
          : `❌ Sorry, your booking request couldn't be accommodated.\n\n${booking.booking_date} at ${booking.start_time}`;

      try {
        await sendTelegramMessage(booking.telegram_chat_id, bookerText);
      } catch (notifyErr) {
        // Don't fail the whole request over a failed booker notification —
        // the merchant-side update already succeeded and is the source of truth.
        console.error("Failed to notify booker:", notifyErr);
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

    const botUsername = process.env.TELEGRAM_BOT_USERNAME;
    const deepLink = `https://t.me/${botUsername}?start=${token}`;

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

    const botUsername = process.env.TELEGRAM_BOT_USERNAME; // e.g. "EatDokoBot" (without @)
    const deepLink = `https://t.me/${botUsername}?start=${token}`;

    return res.status(200).json({ deepLink });
  } catch (error) {
    console.error('Error creating telegram link:', error);
    return res.status(500).json({ error: 'Failed to generate link.' });
  }
});

// GET /api/booking/:id/telegram-status
// Public, unauthenticated: the customer-facing "Notify me on Telegram" widget
// polls this to find out once the booking has a linked chat_id.
router.get('/booking/:id/telegram-status', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid booking id.' });

    const result = await zingoPool.query(
      `SELECT "telegram_chat_id" FROM bookings WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const chatId = result.rows[0].telegram_chat_id;
    return res.status(200).json({
      connected: Boolean(chatId),
      chatId: chatId ? String(chatId) : null,
    });
  } catch (error) {
    console.error('Error polling booking telegram status:', error);
    return res.status(500).json({ error: 'Failed to check status.' });
  }
});

// POST /api/telegram-webhook
router.post("/telegram-webhook", async (req, res) => {
  // Always return 200 OK immediately so Telegram doesn't retry delivery
  res.sendStatus(200);

  const { message, callback_query } = req.body || {};
  const dashboardUrl = "https://eatdoko.com";

  const escapeHtml = (str) =>
    String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // =========================================================================
  // 1. User clicked a deep link and launched /start <token>
  //    Token prefixes: sess_ (merchant, unsaved page) | bk_ (customer booking)
  //    pg_ (merchant, existing saved page)
  // =========================================================================
  if (message && message.text && message.text.startsWith("/start ")) {
    const chatId = message.chat.id;
    const senderName = message.from.first_name || "there";
    const username = message.from.username ? `@${message.from.username}` : senderName;
    const rawToken = message.text.split(" ")[1]?.trim();

    if (!rawToken) return;

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

        const keyboard = {
          inline_keyboard: [
            [{ text: `✅ Connect as ${username}`, callback_data: `confirm_tg:${rawToken}` }],
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
        const keyboard = {
          inline_keyboard: [
            [{ text: `✅ Connect as ${username}`, callback_data: `confirm_tg:${rawToken}` }],
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

      // --- Case C: Customer, notify on a single booking ---
      if (rawToken.startsWith("bk_")) {
        const bookingId = rawToken.replace("bk_", "");
        const bookingRes = await zingoPool.query(
          `SELECT b.id, b.full_name, bp.name AS business_name
           FROM bookings b
           JOIN booking_pages bp ON bp.id = b.booking_page_id
           WHERE b.id = $1 LIMIT 1`,
          [bookingId]
        );

        if (bookingRes.rowCount === 0) {
          await sendTelegramMessage(chatId, "⚠️ We couldn't find that booking. It may have been removed.");
          return;
        }

        const booking = bookingRes.rows[0];
        const businessName = escapeHtml(booking.business_name);
        const keyboard = {
          inline_keyboard: [[{ text: "✅ Notify me here", callback_data: `confirm_bk:${booking.id}` }]],
        };

        await sendTelegramMessage(
          chatId,
          `Hi! Connect this chat to get updates on your booking at <b>${businessName}</b>?`,
          keyboard
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

  // =========================================================================
  // 2. User tapped an inline button
  // =========================================================================
  if (callback_query) {
    const callbackId = callback_query.id;
    const data = callback_query.data;
    const chatId = callback_query.message.chat.id;
    const messageId = callback_query.message.message_id;

    // --- Action: Booking accept/decline (merchant side) ---
    if (data.startsWith("accept:") || data.startsWith("decline:")) {
      await handleBookingStatusCallback(callback_query);
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

    // --- Action: Customer confirms booking notification chat ---
    if (data.startsWith("confirm_bk:")) {
      const bookingId = data.replace("confirm_bk:", "").trim();

      if (!UUID_RE.test(bookingId)) {
        await answerCallbackQuery(callbackId, "Invalid booking.");
        return;
      }

      try {
        const result = await zingoPool.query(
          `UPDATE bookings SET telegram_chat_id = $1 WHERE id = $2 RETURNING id, phone`,
          [chatId, bookingId]
        );

        if (result.rowCount > 0) {
          const booking = result.rows[0];

          // Link/refresh this chat_id against the shared telegram_contacts
          // table, keyed on the booking's phone number.
          await linkTelegramContact({
            chatId,
            phoneNumber: booking.phone,
            username: callback_query.from.username || null,
          });

          await answerCallbackQuery(callbackId, "Connected!");
          await editTelegramMessage(
            chatId,
            messageId,
            `You're all set — we'll message you here as soon as your booking is confirmed.`
          );
        } else {
          await answerCallbackQuery(callbackId, "Booking not found.");
          await editTelegramMessage(chatId, messageId, "⚠️ We couldn't find that booking anymore.");
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