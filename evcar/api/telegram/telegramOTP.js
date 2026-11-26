const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const zingoPool = require('../../../database/pgZingo');
const { normalizePhoneNumber } = require('../../../lib/normalizePhoneNumber');
const { sendTelegramMessage } = require('./telegramWebhook');

// Single source of truth for sessions + cookies (adjust the path if needed)
const {
  SESSION_COOKIE,
  cookieOptions,
  readCookie,
  issueSession,
  requireAuth,
  destroySession,
  csrfOrigin,
} = require('./session');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const AUTH_URL = 'https://oauth.telegram.org/auth';
const TOKEN_URL = 'https://oauth.telegram.org/token';
const JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json';
const ISSUER = 'https://oauth.telegram.org';

// Same __Host- rules as the session cookie (Secure, Path=/, no Domain)
const OIDC_COOKIE = '__Host-tg_oidc';
const OIDC_MAX_AGE = 10 * 60 * 1000;

const CLIENT_ID = process.env.EV_TELEGRAM_CLIENT_ID;
const CLIENT_SECRET = process.env.EV_TELEGRAM_CLIENT_SECRET;
const REDIRECT_URI = process.env.EV_TELEGRAM_REDIRECT_URI;
const FRONTEND_URL ="https://zeloev.com";


// Startup check: shows which variables are missing (never prints values)
console.log('[Telegram login] config:', {
  EV_TELEGRAM_CLIENT_ID: CLIENT_ID ? 'set' : 'MISSING',
  EV_TELEGRAM_CLIENT_SECRET: CLIENT_SECRET ? 'set' : 'MISSING',
  EV_TELEGRAM_REDIRECT_URI: REDIRECT_URI || 'MISSING',
  FRONTEND_URL: FRONTEND_URL || 'MISSING',
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const b64url = (buf) => buf.toString('base64url');
const safePath = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/');

let jwks;
async function verifyIdToken(idToken, nonce) {
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ISSUER,
    audience: String(CLIENT_ID),
  });
  if (payload.nonce && payload.nonce !== nonce) throw new Error('Nonce mismatch');
  return payload;
}

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */
async function findOrCreateUser({ telegramId, phone, name, username, picture, referredBy }) {
  const { rows } = await zingoPool.query(
    `INSERT INTO ev_users
       (telegram_id, telegram_username, name, avatar_url, phone_number, referred_by, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET
       telegram_username = EXCLUDED.telegram_username,
       name              = COALESCE(EXCLUDED.name, ev_users.name),
       avatar_url        = COALESCE(EXCLUDED.avatar_url, ev_users.avatar_url),
       phone_number      = COALESCE(EXCLUDED.phone_number, ev_users.phone_number),
       last_login_at     = NOW(),
       updated_at        = NOW()
     RETURNING *, (xmax = 0) AS is_new`,
    [telegramId, username, name, picture, phone, referredBy]
  );

  const { is_new, ...user } = rows[0];
  console.log('[Telegram login] user row:', { id: user.id, isNew: is_new });
  return { user, isNew: is_new };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// GET /auth/telegram/start?callback=/dashboard&ref=123
router.get('/auth/telegram/start', (req, res) => {
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const ref = /^\d+$/.test(req.query.ref || '') ? req.query.ref : null;

  res.cookie(
    OIDC_COOKIE,
    JSON.stringify({ state, nonce, verifier, ref, callback: safePath(req.query.callback) }),
    { ...cookieOptions, maxAge: OIDC_MAX_AGE }
  );

  const params = new URLSearchParams({
    client_id: String(CLIENT_ID),
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile phone telegram:bot_access',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return res.redirect(`${AUTH_URL}?${params.toString()}`);
});

// GET /auth/telegram/callback  (register this URL in BotFather > Login Widget)
router.get('/auth/telegram/callback', async (req, res) => {
  const fail = (reason) => {
    console.log('[Telegram callback] FAIL:', reason);
    return res.redirect(`${FRONTEND_URL}/signup?error=${reason}`);
  };

  try {
    if (req.query.error) return fail('denied');

    const saved = JSON.parse(readCookie(req, OIDC_COOKIE) || 'null');
    res.clearCookie(OIDC_COOKIE, cookieOptions);

    const { code, state } = req.query;
    if (!saved || !code || !state) return fail('invalid');

    const a = Buffer.from(String(state));
    const b = Buffer.from(saved.state);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail('invalid');

    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const { data } = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: REDIRECT_URI,
        client_id: String(CLIENT_ID),
        code_verifier: saved.verifier,
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        timeout: 8000,
      }
    );

    const claims = await verifyIdToken(data.id_token, saved.nonce);
    const telegramId = String(claims.id ?? claims.sub);
    const phone = claims.phone_number ? normalizePhoneNumber(claims.phone_number) : null;

    const { user, isNew } = await findOrCreateUser({
      telegramId,
      phone,
      name: claims.name,
      username: claims.preferred_username,
      picture: claims.picture,
      referredBy: saved.ref,
    });

    // Shared session module: sets the __Host-session cookie
    await issueSession(req, res, user);

    // Remove the legacy cookie from the old implementation, if the browser still has it.
    // (Only works if the options match how it was set, so include the old domain.)
    res.clearCookie('session', {
      path: '/',
      ...(process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN }),
    });

    // Welcome DM (fire and forget; fails silently if bot access wasn't granted)
    if (isNew) {
      sendTelegramMessage(telegramId, `Welcome to EV Car, ${claims.name || 'there'}! 🎉`);
    }

    return res.redirect(`${FRONTEND_URL}${saved.callback}`);
  } catch (err) {
    console.error('[Telegram login] failed:', err.response?.data || err.message);
    return fail('failed');
  }
});

// GET /me -> current logged-in user
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

// POST /logout
router.post('/logout', csrfOrigin, async (req, res) => {
  try {
    await destroySession(req, res);
  } catch (err) {
    console.error('[Auth] logout error:', err.message);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
  }
  res.json({ success: true });
});

module.exports = router;
// Re-exported so existing `require('./telegramAuth').requireAuth` imports keep working
module.exports.requireAuth = requireAuth;