const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const zingoPool = require('../../../database/pgZingo'); // adjust paths to match your route file
const { normalizePhoneNumber } = require('../../../lib/normalizePhoneNumber');

const router = express.Router();

const NONCE_TTL_MINUTES = 10; // how long the Telegram link stays valid
const OTP_TTL_MINUTES = 1;    // matches your existing 1-minute OTP window
const NONCE_FORMAT = /^[A-Za-z0-9_-]{16,64}$/;

console.log(
    `[Telegram OTP] Bot name: ${process.env.ACME_TELEGRAM_LOGIN_BOT_NAME}, Token: ${process.env.ACME_TELEGRAM_LOGIN_BOT_TOKEN ? 'set' : 'not set'}`
)

// Compare phones regardless of format: strips non-digits, a leading 855, and a leading 0
const canonicalPhone = (p) =>
  String(p || '').replace(/\D/g, '').replace(/^855/, '').replace(/^0/, '');

// Returns true if Telegram accepted the message
async function tgSend(chatId, text, extra = {}) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.ACME_TELEGRAM_LOGIN_BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, ...extra },
      { timeout: 8000 }
    );
    return true;
  } catch (err) {
    console.error('[Telegram Bot] sendMessage failed:', err.response?.data || err.message);
    return false;
  }
}

// Used by the resend route too
async function sendOtpToChat(chatId, otp) {
  return tgSend(chatId, `Your verification code is ${otp}\nIt expires in ${OTP_TTL_MINUTES} minute.`, {
    reply_markup: { remove_keyboard: true },
  });
}

/* ---------------------------------------------------------------
 * 1) Website asks for a one-time bot link
 * ------------------------------------------------------------- */
router.post('/user/registration/telegram/start', async (req, res) => {
  try {
    if (!process.env.ACME_TELEGRAM_LOGIN_BOT_NAME) {
      return res.status(500).json({ success: false, error: 'Telegram is not configured' });
    }

    const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
    const nonce = crypto.randomBytes(16).toString('base64url');

    const result = await zingoPool.query(
      `UPDATE booking_otp
          SET tg_nonce = $1,
              tg_nonce_expires_at = NOW() + INTERVAL '${NONCE_TTL_MINUTES} minutes',
              tg_status = 'pending',
              tg_chat_id = NULL,
              tg_user_id = NULL
        WHERE phone_number = $2
        RETURNING tg_nonce_expires_at`,
      [nonce, phoneNumber]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'No pending registration found for this number. Please start sign up again.',
      });
    }

    return res.json({
      success: true,
      nonce,
      deepLink: `https://t.me/${process.env.ACME_TELEGRAM_LOGIN_BOT_NAME}?start=${nonce}`,
      expiresAt: result.rows[0].tg_nonce_expires_at,
    });
  } catch (error) {
    console.error('Error in telegram/start:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ---------------------------------------------------------------
 * 2) Website polls this while the user is in Telegram
 * ------------------------------------------------------------- */
router.get('/user/registration/telegram/status/:nonce', async (req, res) => {
  try {
    const { nonce } = req.params;
    if (!NONCE_FORMAT.test(nonce)) return res.json({ status: 'expired' });

    const { rows } = await zingoPool.query(
      `SELECT tg_status, (tg_nonce_expires_at < NOW()) AS nonce_expired
         FROM booking_otp
        WHERE tg_nonce = $1`,
      [nonce]
    );

    if (rows.length === 0) return res.json({ status: 'expired' });

    const { tg_status, nonce_expired } = rows[0];
    if (nonce_expired && tg_status !== 'code_sent') return res.json({ status: 'expired' });

    return res.json({ status: tg_status });
  } catch (error) {
    console.error('Error in telegram/status:', error);
    return res.status(500).json({ status: 'error' });
  }
});

/* ---------------------------------------------------------------
 * 3) Telegram calls this for every message sent to the bot
 * ------------------------------------------------------------- */
router.post('/telegram/otp/webhook', async (req, res) => {
  // Only Telegram knows this secret (set via setWebhook secret_token)
  if (req.get('x-telegram-bot-api-secret-token') !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  // Always answer 200 quickly so Telegram doesn't retry
  res.sendStatus(200);

  try {
    const message = req.body?.message;
    if (!message?.chat?.id) return;

    const chatId = message.chat.id;

    // ── /start <nonce> ──────────────────────────────────────────
    if (typeof message.text === 'string' && message.text.startsWith('/start')) {
      const nonce = message.text.split(' ')[1];

      if (!nonce || !NONCE_FORMAT.test(nonce)) {
        await tgSend(chatId, 'Please start from the website to get your verification code.');
        return;
      }

      const result = await zingoPool.query(
        `UPDATE booking_otp
            SET tg_status = 'awaiting_contact', tg_chat_id = $2, tg_user_id = $3
          WHERE tg_nonce = $1 AND tg_nonce_expires_at > NOW() AND tg_status = 'pending'
          RETURNING phone_number`,
        [nonce, chatId, message.from?.id]
      );

      if (result.rowCount === 0) {
        await tgSend(chatId, 'This link is invalid or has expired. Please start again on the website.');
        return;
      }

      await tgSend(chatId, 'Tap the button below to share your phone number and get your code.', {
        reply_markup: {
          keyboard: [[{ text: 'Share my number', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return;
    }

    // ── contact shared ─────────────────────────────────────────
    if (message.contact) {
      const { contact, from } = message;

      // Must be their OWN contact, not a forwarded one
      if (!from || contact.user_id !== from.id) {
        await tgSend(chatId, 'Please use the button to share your own number.');
        return;
      }

      const { rows } = await zingoPool.query(
        `SELECT phone_number FROM booking_otp
          WHERE tg_chat_id = $1 AND tg_status = 'awaiting_contact' AND tg_nonce_expires_at > NOW()`,
        [chatId]
      );

      if (rows.length === 0) {
        await tgSend(chatId, 'No pending verification found. Please start again on the website.', {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }

      const pendingPhone = rows[0].phone_number;

      if (canonicalPhone(contact.phone_number) !== canonicalPhone(pendingPhone)) {
        await zingoPool.query(
          `UPDATE booking_otp SET tg_status = 'phone_mismatch' WHERE phone_number = $1`,
          [pendingPhone]
        );
        await tgSend(chatId, "That number doesn't match the one you entered on the website.", {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }

      // Phone proven. Only now do we create a fresh OTP.
      const otp = crypto.randomInt(100000, 1000000).toString();

      await zingoPool.query(
        `UPDATE booking_otp
            SET otp_code = $1, attempts = 0,
                created_at = CURRENT_TIMESTAMP,
                expires_at = CURRENT_TIMESTAMP + INTERVAL '${OTP_TTL_MINUTES} minute'
          WHERE phone_number = $2`,
        [otp, pendingPhone]
      );

      const sent = await sendOtpToChat(chatId, otp);

      if (sent) {
        await zingoPool.query(
          `UPDATE booking_otp SET tg_status = 'code_sent' WHERE phone_number = $1`,
          [pendingPhone]
        );
      }
      return;
    }

    // anything else
    await tgSend(chatId, 'Please start from the website to get your verification code.');
  } catch (error) {
    console.error('Error in telegram webhook:', error);
  }
});

module.exports = router;
module.exports.sendOtpToChat = sendOtpToChat;