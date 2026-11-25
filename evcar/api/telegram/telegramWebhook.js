const express = require('express');
const axios = require('axios');

const router = express.Router();

const API = `https://api.telegram.org/bot${process.env.EV_TELEGRAM_LOGIN_BOT_TOKEN}`;

async function sendTelegramMessage(chatId, text, extra = {}) {
  try {
    await axios.post(`${API}/sendMessage`, { chat_id: chatId, text, ...extra }, { timeout: 8000 });
    return true;
  } catch (err) {
    console.error('[Telegram bot] sendMessage failed:', err.response?.data || err.message);
    return false;
  }
}

// POST /telegram/webhook
router.post('/telegram/webhook', (req, res) => {
  if (req.get('x-telegram-bot-api-secret-token') !== process.env.EV_TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer fast so Telegram doesn't retry

  const message = req.body?.message;
  if (!message?.chat?.id) return;

  sendTelegramMessage(message.chat.id, 'Tap below to sign in or create your account.', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Open Acme Reserve', url: process.env.NEXT_PUBLIC_FRONTEND }]],
    },
  });
});

module.exports = router;
module.exports.sendTelegramMessage = sendTelegramMessage;