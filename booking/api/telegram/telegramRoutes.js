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

    const originalText = callbackQuery.message?.text || "";
    const responderName = callbackQuery.from.username
      ? `@${callbackQuery.from.username}`
      : callbackQuery.from.first_name;
    const statusLine =
      newStatus === "confirmed"
        ? `✅ Confirmed by ${responderName}`
        : `❌ Declined by ${responderName}`;

    // Phone numbers in plain Telegram message text are auto-linkified on
    // mobile — tapping one offers Call / Message / Copy, so no button
    // (and no tel:/sms: URL scheme, which inline keyboards don't support) needed.
    const contactLine = booking.phone
      ? `\n📱 ${booking.full_name}: ${booking.phone}`
      : "";

    await editTelegramMessage(chatId, messageId, `${originalText}\n\n${statusLine}${contactLine}`);
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

// POST /api/telegram-webhook
// POST /api/telegram-webhook
router.post("/telegram-webhook", async (req, res) => {
  // Always return 200 OK immediately so Telegram doesn't retry delivery
  res.sendStatus(200);

  const { message, callback_query } = req.body || {};
  const dashboardUrl = "https://eatdoko.com";
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;

  const escapeHtml = (str) =>
    String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

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
            `✅ You're set — we'll message you here as soon as your booking at <b>${businessName}</b> is confirmed.\nOr track your booking at: ${process.env.NEXT_PUBLIC_FRONTEND}/my-bookings/${bookingId}`
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