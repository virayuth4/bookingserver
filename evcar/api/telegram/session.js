const crypto = require('crypto');
const zingoPool = require('../../../database/pgZingo');

const SESSION_COOKIE = '__Host-session';
const ABSOLUTE_DAYS = 30;   // hard limit
const IDLE_DAYS = 7;        // logged out if unused this long
const MAX_SESSIONS = 10;    // per user
const TOUCH_MINUTES = 5;    // how often last_seen_at is refreshed

// __Host- requires: Secure, Path=/, no Domain (needs HTTPS)
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  const part = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

// Always creates a brand-new session ID (prevents session fixation)
async function issueSession(req, res, user) {
  const oldToken = readCookie(req, SESSION_COOKIE);
  if (oldToken) {
    await zingoPool.query('DELETE FROM ev_sessions WHERE id = $1', [sha256(oldToken)]);
  }

  const token = crypto.randomBytes(32).toString('base64url');

  await zingoPool.query(
    `INSERT INTO ev_sessions (id, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, NOW() + $3 * INTERVAL '1 day', $4, $5)`,
    [sha256(token), user.id, ABSOLUTE_DAYS, req.ip, (req.get('user-agent') || '').slice(0, 300)]
  );

  // Keep only the newest MAX_SESSIONS for this user
  await zingoPool.query(
    `DELETE FROM ev_sessions
      WHERE user_id = $1
        AND id NOT IN (
          SELECT id FROM ev_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
        )`,
    [user.id, MAX_SESSIONS]
  );

  res.cookie(SESSION_COOKIE, token, {
    ...cookieOptions,
    maxAge: ABSOLUTE_DAYS * 24 * 60 * 60 * 1000,
  });
  console.log('[Session] created for user id:', user.id);
}

async function requireAuth(req, res, next) {
  try {
    const token = readCookie(req, SESSION_COOKIE);
    console.log('cookie header:', req.headers.cookie ? 'present' : 'none', '| proto:', req.protocol);
    console.log("token", token)
    const names = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')[0]);
console.log('cookie names:', names);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const { rows } = await zingoPool.query(
      `SELECT s.id AS sid, s.last_seen_at,
              u.id, u.name, u.telegram_username, u.avatar_url, u.phone_number
         FROM ev_sessions s
         JOIN ev_users u ON u.id = s.user_id
        WHERE s.id = $1
          AND s.expires_at > NOW()
          AND s.last_seen_at > NOW() - $2 * INTERVAL '1 day'`,
      [sha256(token), IDLE_DAYS]
    );

    const row = rows[0];
    if (!row) {
      res.clearCookie(SESSION_COOKIE, cookieOptions);
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Refresh the idle timer, but not on every request
    if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_MINUTES * 60 * 1000) {
      zingoPool
        .query('UPDATE ev_sessions SET last_seen_at = NOW() WHERE id = $1', [row.sid])
        .catch((e) => console.error('[Session] touch failed:', e.message));
    }

    const { sid, last_seen_at, ...user } = row;
    req.user = user;
    next();
  } catch (err) {
    console.error('[Session] error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
}


async function getOptionalUserId(req) {
  try {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;

    const { rows } = await zingoPool.query(
      `SELECT user_id
         FROM ev_sessions
        WHERE id = $1
          AND expires_at > NOW()
          AND last_seen_at > NOW() - $2 * INTERVAL '1 day'`,
      [sha256(token), IDLE_DAYS]
    );
    return rows[0]?.user_id ?? null;
  } catch (e) {
    console.error('[Session] optional lookup failed:', e.message);
    return null; // tracking must never fail because of auth
  }
}

async function destroySession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await zingoPool.query('DELETE FROM ev_sessions WHERE id = $1', [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, cookieOptions);
}

async function destroyAllSessions(userId, res) {
  await zingoPool.query('DELETE FROM ev_sessions WHERE user_id = $1', [userId]);
  res.clearCookie(SESSION_COOKIE, cookieOptions);
}

// CSRF defense in depth: state-changing requests must come from your own origin.
// Apply per route. Do NOT use on the Telegram webhook (Telegram sends no Origin header).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

function csrfOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  let origin = req.get('origin');
  if (!origin && req.get('referer')) {
    try { origin = new URL(req.get('referer')).origin; } catch { /* ignore */ }
  }

  if (!origin || !allowedOrigins.includes(origin)) {
    console.warn('[CSRF] blocked', req.method, req.originalUrl, 'origin:', origin || 'none');
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Deletes expired and idle sessions (hourly)
function startSessionCleanup() {
  const run = () =>
    zingoPool
      .query(
        `DELETE FROM ev_sessions
          WHERE expires_at < NOW() OR last_seen_at < NOW() - $1 * INTERVAL '1 day'`,
        [IDLE_DAYS]
      )
      .catch((e) => console.error('[Session] cleanup failed:', e.message));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = {
  SESSION_COOKIE,
  cookieOptions,
  readCookie,
  issueSession,
  requireAuth,
  destroySession,
  destroyAllSessions,
  csrfOrigin,
  startSessionCleanup,
  getOptionalUserId
};