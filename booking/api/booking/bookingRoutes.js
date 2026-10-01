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
const { getPageForMerchant } = require("../../../lib/getPageForMerchant");
const { UUID_RE } = require("../../../lib/uuidRe");
const { formatRequestedAt, formatBookingDate, formatBookingTime } = require("../../../lib/formats");
const { getVerifiedTelegramUser, verifyInitData, sendCustomerReceipt } = require("../../../lib/verifyInitData");
const { buildMerchantBookingText, PENDING_KEYBOARD, resolveServiceLabel } = require("../telegram/telegramRoutes");
const { buildBookingKeyboard } = require("../../../lib/bookingKeyboard");
const { parseTelegramInput } = require("../../../lib/parsers");


const DEBUG_BOOKING = process.env.DEBUG_BOOKING !== 'false'; // set DEBUG_BOOKING=false in DO when done

function dbg(reqId, label, data) {
  if (!DEBUG_BOOKING) return;
  if (data === undefined) console.log(`[booking:${reqId}] ${label}`);
  else console.log(`[booking:${reqId}] ${label}`, data);
}

function mask(v, keep = 2) {
  if (v === null || v === undefined || v === '') return v;
  const s = String(v);
  return `${s.slice(0, keep)}***(${s.length})`;
}

// Describes a bot token without revealing it. The bot id (digits before ":") is public info.
function describeToken(raw) {
  const t = raw ?? '';
  return {
    loaded: Boolean(t),
    length: t.length,
    botId: t.split(':')[0] || null,
    hasWhitespace: t !== t.trim(),
    hasQuotes: /^["']|["']$/.test(t),
    formatOk: /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(t.trim()),
  };
}

// Calls the Telegram Bot API and never throws. Returns { httpStatus, data, networkError, ms }.
async function telegramCall(token, method, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    return { httpStatus: res.status, data, networkError: null, ms: Date.now() - t0 };
  } catch (err) {
    return {
      httpStatus: null,
      data: null,
      networkError: { name: err.name, message: err.message, cause: err.cause?.code || err.cause?.message },
      ms: Date.now() - t0,
    };
  }
}

// Run this AFTER a failed sendMessage to find out which layer is broken.
async function diagnoseTelegramFailure(reqId, token, chatId, failure) {
  console.error(`[booking:${reqId}] sendMessage FAILED`, failure);

  // 1. Is the token valid at all?
  const me = await telegramCall(token, 'getMe');
  if (me.networkError || !me.data?.ok) {
    console.error(`[booking:${reqId}] DIAGNOSIS: TOKEN problem. getMe failed`, {
      httpStatus: me.httpStatus,
      data: me.data,
      networkError: me.networkError,
      token: describeToken(token),
    });
    return {
      stage: 'token',
      detail: me.data?.description || me.networkError?.message || 'getMe failed',
    };
  }
  console.error(`[booking:${reqId}] token is VALID for bot`, {
    id: me.data.result.id,
    username: me.data.result.username,
  });

  // 2. Can this bot see the venue's chat?
  const chat = await telegramCall(token, 'getChat', { chat_id: chatId });
  if (!chat.data?.ok) {
    console.error(`[booking:${reqId}] DIAGNOSIS: CHAT problem. Bot @${me.data.result.username} cannot access chat ${mask(chatId, 3)}`, {
      httpStatus: chat.httpStatus,
      data: chat.data,
    });
    return { stage: 'chat', detail: chat.data?.description || 'getChat failed' };
  }
  console.error(`[booking:${reqId}] chat is reachable`, { type: chat.data.result.type });

  // 3. Token and chat are fine, so the message itself was rejected (HTML parse error, bad keyboard, etc.)
  console.error(`[booking:${reqId}] DIAGNOSIS: MESSAGE problem. Check the text for unescaped < > & and the reply_markup`);
  return { stage: 'message', detail: failure?.data?.description || 'sendMessage rejected' };
}

// Call once at server start (inside app.listen callback) so you see the token state in the deploy logs.
async function logMerchantTokenAtStartup() {
  const token = (process.env.MERCHANT_TELEGRAM_BOT_TOKEN || '').trim();
  console.log('[startup] merchant token', describeToken(process.env.MERCHANT_TELEGRAM_BOT_TOKEN));
  if (!token) return;
  const me = await telegramCall(token, 'getMe');
  console.log('[startup] merchant getMe', me.data?.ok
    ? { ok: true, botId: me.data.result.id, username: me.data.result.username }
    : { ok: false, httpStatus: me.httpStatus, data: me.data, networkError: me.networkError });
}



function tokenFingerprint(raw) {
  const t = (raw || '').trim();
  return {
    botId: t.split(':')[0],
    sha256: crypto.createHash('sha256').update(t).digest('hex').slice(0, 8),
    last4: t.slice(-4),
  };
}

console.log('[startup] merchant token fingerprint', tokenFingerprint(process.env.MERCHANT_TELEGRAM_BOT_TOKEN));

// ---------------------------------------------------------------------------
// Booking page settings
// ---------------------------------------------------------------------------

const BOOKING_TABLE = 'booking_pages';
const MAX_IMAGES_PER_ROW = 5;
const MAX_TOTAL_IMAGES = 40; // sanity cap across all rows combined; adjust as you like
const MAX_CLOSED_DATES = 366;
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PLAN_LIMITS = { basic: 1, pro: 10 };
const DEFAULT_PLAN = 'basic';

const bookingUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: MAX_TOTAL_IMAGES,    // hard cap on total files per request, across all rows
  },
});

// Field names are dynamic ("images_row_0", "images_row_1", ...) since rows are
// user-defined, so we can't use .fields() with a fixed list. .any() accepts
// any field name; groupNewFilesByRow() below filters req.files down to only
// fieldnames matching /^images_row_(\d+)$/ and silently drops anything else.
const handleBookingMulter = bookingUpload.any();

function parseJsonField(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const getSlots = (day) => {
  if (!day || day.closed) return [];
  if (Array.isArray(day.slots) && day.slots.length) return day.slots;
  if (day.open && day.close) return [{ open: day.open, close: day.close }];
  return [];
};

function parseHours(raw) {
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { error: 'Invalid opening hours.' }; }
  if (!obj || typeof obj !== 'object') return { error: 'Invalid opening hours.' };

  const out = {};
  for (const k of DAY_KEYS) {
    const d = obj[k];
    if (!d) return { error: `Missing hours for ${k}.` };
    if (d.closed) { out[k] = { closed: true, slots: [] }; continue; }

    // accept legacy {open, close} too
    const rawSlots = Array.isArray(d.slots) && d.slots.length ? d.slots : [{ open: d.open, close: d.close }];
    if (rawSlots.length > 3) return { error: `Too many time ranges on ${k}.` };
    for (const s of rawSlots) {
      if (!TIME_RE.test(s.open) || !TIME_RE.test(s.close)) return { error: `Invalid time on ${k}.` };
    }
    const slots = rawSlots.map(({ open, close }) => ({ open, close }))
                          .sort((a, b) => a.open.localeCompare(b.open));
    out[k] = { closed: false, open: slots[0].open, close: slots[0].close, slots };
  }
  return { value: out };
}

function parseClosedDates(raw) {
  const dates = parseJsonField(raw, []);
  if (!Array.isArray(dates)) {
    return { error: 'Closed dates must be a list.' };
  }
  if (dates.length > MAX_CLOSED_DATES) {
    return { error: `You can add up to ${MAX_CLOSED_DATES} closed dates.` };
  }

  const cleaned = new Set();
  for (const d of dates) {
    if (typeof d !== 'string' || !DATE_RE.test(d) || Number.isNaN(Date.parse(d))) {
      return { error: `Invalid closed date: ${d}` };
    }
    cleaned.add(d);
  }

  return { value: [...cleaned].sort() };
}

function parsePhoneInput(phone) {
  const value = (phone || '').trim();
  if (!value) return { value: null };
  if (!/^\+?[0-9\s\-().]{6,20}$/.test(value)) {
    return { error: 'Phone number is invalid.' };
  }
  return { value };
}


// Parses the telegram_chat_id sent from the "Verify & Connect Telegram" flow.
// Telegram chat IDs are integers (can be negative for groups/channels), so we
// validate loosely as a numeric string and store it as text.
function parseTelegramChatId(raw) {
  if (raw === undefined || raw === null) return { value: undefined }; // not provided at all
  const value = String(raw).trim();
  if (!value) return { value: null }; // explicitly cleared
  if (!/^-?\d+$/.test(value)) {
    return { error: 'Invalid Telegram chat id.' };
  }
  return { value };
}

function slugify(text) {
  return (text || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function parseExistingImagePaths(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string" && u.trim()) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Image row helpers
// ---------------------------------------------------------------------------

/**
 * Parses the "image_rows_meta" field sent by the client:
 *   [{ label, existing_image_paths: [url, ...] }, ...]
 * Returns { value, error }.
 */
function parseImageRowsMeta(raw) {
  if (!raw) return { value: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Invalid image rows data.' };
  }
  if (!Array.isArray(parsed)) return { error: 'Invalid image rows data.' };

  const value = [];
  for (const row of parsed) {
    const label = (row?.label || '').toString().trim();
    if (!label) return { error: 'Each photo row needs a name.' };
    const existing = Array.isArray(row?.existing_image_paths)
      ? row.existing_image_paths.filter((u) => typeof u === 'string')
      : [];
    if (existing.length > MAX_IMAGES_PER_ROW) {
      return { error: `"${label}" can have up to ${MAX_IMAGES_PER_ROW} photos.` };
    }
    value.push({ label, existing_image_paths: existing });
  }
  return { value };
}

/**
 * req.files comes back flat from multer.any(). Groups them by row index
 * based on fieldname "images_row_<idx>".
 * Returns a Map<number, Express.Multer.File[]>.
 */
function groupNewFilesByRow(files) {
  const byRow = new Map();
  const re = /^images_row_(\d+)$/;
  for (const file of files || []) {
    const match = re.exec(file.fieldname);
    if (!match) continue; // ignore anything unexpected
    const idx = Number(match[1]);
    if (!byRow.has(idx)) byRow.set(idx, []);
    byRow.get(idx).push(file);
  }
  return byRow;
}

/**
 * Builds the final image_rows array (label + all image paths per row),
 * uploading any new files to S3 along the way.
 * rowsMeta: [{ label, existing_image_paths }]
 * newFilesByRow: Map<number, Express.Multer.File[]>
 */
async function buildImageRows(rowsMeta, newFilesByRow, slug) {
  const imageRows = [];
  let totalCount = 0;

  for (let idx = 0; idx < rowsMeta.length; idx++) {
    const { label, existing_image_paths: existing } = rowsMeta[idx];
    const newFiles = newFilesByRow.get(idx) || [];

    if (existing.length + newFiles.length > MAX_IMAGES_PER_ROW) {
      throw Object.assign(new Error(`"${label}" can have up to ${MAX_IMAGES_PER_ROW} photos.`), {
        status: 400,
      });
    }

    let uploaded = [];
    if (newFiles.length) {
      uploaded = await uploadMediaFilesToS3(newFiles, slug, 'image', {
        pathPrefix: 'eatdoko/booking-pages/gallery',
      });
    }

    const paths = [...existing, ...uploaded];
    totalCount += paths.length;
    imageRows.push({ label, image_paths: paths });
  }

  if (totalCount > MAX_TOTAL_IMAGES) {
    throw Object.assign(new Error(`You can upload up to ${MAX_TOTAL_IMAGES} photos in total.`), {
      status: 400,
    });
  }

  return imageRows;
}

/** Flattens every image_paths url across all rows of a stored image_rows value. */
function flattenImageRowPaths(imageRows) {
  if (!Array.isArray(imageRows)) return [];
  return imageRows.flatMap((row) => (Array.isArray(row?.image_paths) ? row.image_paths : []));
}

/**
 * Reads whichever gallery shape a page row currently has — new "image_rows"
 * JSONB column if present/populated, otherwise the legacy flat "image_paths"
 * column folded into a single "Photos" row. Use this everywhere a page needs
 * to be treated as a list of rows, so old, not-yet-resaved pages keep working.
 */
function normalizeImageRows(page) {
  if (Array.isArray(page.image_rows) && page.image_rows.length) {
    return page.image_rows;
  }
  const legacy = parseExistingImagePaths(page.image_paths);
  return legacy.length ? [{ label: 'Photos', image_paths: legacy }] : [];
}

// Single definition (the duplicate has been removed)
async function uniqueBookingSlug(name, excludePageId = null) {
  const root = slugify(name) || 'booking';
  let slug = root;
  let n = 2;
  while (
    (
      await zingoPool.query(
        `SELECT 1 FROM "booking_pages" WHERE "slug" = $1 AND ($2::int IS NULL OR "id" <> $2)`,
        [slug, excludePageId]
      )
    ).rowCount > 0
  ) {
    slug = `${root}-${n}`;
    n += 1;
  }
  return slug;
}

async function getMerchantPlan(merchantId) {
  const result = await zingoPool.query(
    `SELECT "plan" FROM "booking_users" WHERE "id" = $1`,
    [merchantId]
  );
  return result.rows[0]?.plan || DEFAULT_PLAN;
}

// Fire-and-forget S3 cleanup that actually logs failures instead of
// silently no-op-ing when deleteFileFromS3 is missing.
async function cleanupRemovedImages(urls) {
  await Promise.all(
    urls.map((url) =>
      deleteFileFromS3(url).catch((e) =>
        console.error('Failed to delete image from S3:', url, e)
      )
    )
  );
}

async function getPageForMerchantBySlug(slug) {
  // example with a SQL-style query
  const result = await zingoPool.query(
    'SELECT * FROM booking_pages WHERE slug = $1',
    [slug]
  );
  return result.rows[0] || null;
}

const CATEGORY_SERVICES_MAP = {
  restaurant: ["Indoor", "Outdoor", "Bar seating", "Private room"],
  barber: ["In-shop haircut", "Beard trim", "Home visit"],
  pilates: ["Group class", "Private 1-on-1", "Duet session"],
  salon: ["Hair", "Nails", "Skincare", "Massage"],
  cafe: ["Dine-in", "Takeaway", "Outdoor patio"],
  other: ["Standard service", "Custom booking"],
};

function parseServiceTypes(raw) {
  const parsed = parseJsonField(raw, []);
  if (!Array.isArray(parsed)) return { value: [] };

  const cleaned = parsed
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().slice(0, 50)); // limit character length

  // Prevent spamming too many services
  return { value: Array.from(new Set(cleaned)).slice(0, 20) };
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

router.get('/bookings/anon/:anonId', async (req, res) => {
  try {
    const { anonId } = req.params; // <-- Use req.params, not req.query
    console.log("anonId", anonId)

    const result = await zingoPool.query(
      `SELECT 
         bookings.*,
         booking_pages.name AS page_name,
         booking_pages.phone AS page_phone,
         booking_pages.telegram AS page_telegram,
         booking_pages.telegram_chat_id AS page_telegram_chat_id
       FROM bookings
       LEFT JOIN booking_pages ON bookings.booking_page_id = booking_pages.id
       WHERE bookings.anon_id = $1`,
      [anonId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    return res.json({ booking: result.rows });
  } catch (err) {
    console.error('Error fetching booking:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/bookings/:slug', authenticateFirebaseToken, async (req, res) => {
  console.log("Booking Slug Route Hit");
  const { slug } = req.params;
  const userId = req.user?.id;

  try {
    const { rows } = await zingoPool.query(
      `SELECT bp.id AS page_id, bp.name, b.*
       FROM booking_pages bp
       LEFT JOIN bookings b ON b.booking_page_id = bp.id
       WHERE bp.slug = $1 AND bp.merchant_id = $2`,
      [slug, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking page not found.' });
    }

    const name = rows[0].name;
    const data = rows
      .filter((r) => r.id !== null) // drop the null row from LEFT JOIN when there are no bookings yet
      .map(({ page_id, name, ...booking }) => booking);

    return res.json({ name, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load bookings.' });
  }
});

router.get('/booking/id/:id', async (req, res) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid booking id.' });
  }

  try {
    const { rows } = await zingoPool.query(
      `SELECT
         b.*,
         bp.name AS business_name,
         bp.sections,
         bp.service_types
       FROM bookings b
       JOIN booking_pages bp ON bp.id = b.booking_page_id
       WHERE b.id = $1
       LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = rows[0];
    const sections = Array.isArray(booking.sections) ? booking.sections : [];
    const serviceTypes = Array.isArray(booking.service_types) ? booking.service_types : [];

    const sectionMatch = sections.find((s) =>
      typeof s === 'string' ? s === booking.section_id : s.id === booking.section_id
    );
    const serviceMatch = serviceTypes.find((s) =>
      typeof s === 'string'
        ? s.toLowerCase().replace(/\s+/g, '-') === booking.service_type_id || s === booking.service_type_id
        : s.id === booking.service_type_id
    );

    return res.json({
      booking: {
        id: booking.id,
        status: booking.status,
        guests: booking.guests,
        date: booking.booking_date,
        time: booking.start_time,
        fullName: booking.full_name,
        contact: booking.phone,
        note: booking.note,
        businessName: booking.business_name,
        sectionName: typeof sectionMatch === 'string' ? sectionMatch : sectionMatch?.name ?? null,
        serviceTypeName: typeof serviceMatch === 'string' ? serviceMatch : serviceMatch?.name ?? null,
        createdAt: booking.created_at,
      },
    });
  } catch (err) {
    console.error('Fetch booking by id error:', err);
    return res.status(500).json({ error: 'Failed to load booking.' });
  }
});

// ---------------------------------------------------------------------------
// GET /booking-settings  — list all of the current merchant's booking pages
// ---------------------------------------------------------------------------
router.get('/booking-settings', authenticateFirebaseToken, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    if (!merchantId) return res.status(401).json({ error: 'Unauthorized.' });

    const [pagesResult, plan] = await Promise.all([
      zingoPool.query(
        `SELECT "id", "name", "slug", "image_rows", "image_paths", "phone", "telegram", "telegram_chat_id", "map_url",
                "opening_hours", "closed_dates", "created_at", "updated_at"
         FROM "booking_pages" WHERE "merchant_id" = $1 ORDER BY "created_at" ASC`,
        [merchantId]
      ),
      getMerchantPlan(merchantId),
    ]);

    // Normalize so the list view always sees "image_rows", even for pages
    // that haven't been re-saved since the migration yet.
    const data = pagesResult.rows.map((page) => ({
      ...page,
      image_rows: normalizeImageRows(page),
    }));

    return res.status(200).json({
      data,
      plan,
      limit: PLAN_LIMITS[plan] ?? PLAN_LIMITS[DEFAULT_PLAN],
    });
  } catch (error) {
    console.error('Error listing booking settings:', error);
    return res.status(500).json({ error: 'Failed to load booking pages.' });
  }
});
// ---------------------------------------------------------------------------
// GET /booking-settings/:id  — load one page (must belong to this merchant)
// ---------------------------------------------------------------------------
router.get('/booking-settings/id/:id', authenticateFirebaseToken, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    if (!merchantId) return res.status(401).json({ error: 'Unauthorized.' });

    const pageId = Number(req.params.id);
    if (!Number.isInteger(pageId)) {
      return res.status(400).json({ error: 'Invalid page id.' });
    }

    const page = await getPageForMerchant(pageId, merchantId);

    if (!page) return res.status(404).json({ error: 'Booking page not found.' });

    if (page.merchant_id !== merchantId) {
      return res.status(404).json({ error: 'Booking page not found.' });
    }

    return res.status(200).json({ data: { ...page, image_rows: normalizeImageRows(page) } });
  } catch (error) {
    console.error('Error loading booking page:', error);
    return res.status(500).json({ error: 'Failed to load booking page.' });
  }
});
// ---------------------------------------------------------------------------
// GET /booking-settings/:slug — load one page 
// ---------------------------------------------------------------------------
router.get('/booking-settings/slug/:slug',  async (req, res) => {
  try {
    const slug = req.params.slug;
    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({ error: 'Invalid page slug.' });
    }

    const page = await getPageForMerchantBySlug(slug);
    if (!page) return res.status(404).json({ error: 'Booking page not found.' });

    return res.status(200).json({ data: { ...page, image_rows: normalizeImageRows(page) } });
  } catch (error) {
    console.error('Error loading booking page:', error);
    return res.status(500).json({ error: 'Failed to load booking page.' });
  }
});



// ---------------------------------------------------------------------------
// POST /booking-settings  — create a new page (blocked once plan limit is hit)
// ---------------------------------------------------------------------------

router.post('/booking-settings', authenticateFirebaseToken, handleBookingMulter, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    if (!merchantId) return res.status(401).json({ error: 'Unauthorized.' });

    // Plan limit check...
    const plan = await getMerchantPlan(merchantId);
    const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS[DEFAULT_PLAN];
    const { rows: countRows } = await zingoPool.query(
      `SELECT COUNT(*)::int AS count FROM "booking_pages" WHERE "merchant_id" = $1`,
      [merchantId]
    );
    if (countRows[0].count >= limit) {
      return res.status(403).json({
        error:
          plan === 'basic'
            ? 'Your plan allows 1 booking page. Upgrade to Pro to create more.'
            : `You've reached your plan's limit of ${limit} booking pages.`,
        plan,
        limit,
      });
    }

    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    // Validate client-provided slug (fallback to slugify(name))
    const rawSlug = (req.body.slug || '').trim();
    const slug = slugify(rawSlug || name);

    if (!slug || slug.length < 3) {
      return res.status(400).json({ error: 'Booking URL handle must be at least 3 characters long.' });
    }
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'Booking URL handle can only contain lowercase letters, numbers, and hyphens.' });
    }

    // Check slug collision
    const existingSlug = await zingoPool.query(
      `SELECT 1 FROM "booking_pages" WHERE "slug" = $1 LIMIT 1`,
      [slug]
    );
    if (existingSlug.rowCount > 0) {
      return res.status(400).json({ error: `The link "${slug}" is already taken. Please choose another.` });
    }

    const category = (req.body.category || '').trim().toLowerCase();
    const serviceTypesResult = parseServiceTypes(req.body.service_types);
    const { value: phoneValue, error: phoneError } = parsePhoneInput(req.body.phone);
    if (phoneError) return res.status(400).json({ error: phoneError });

    const { value: telegramValue, error: telegramError } = parseTelegramInput(req.body.telegram);
    if (telegramError) return res.status(400).json({ error: telegramError });

    // Chat id captured from the "Verify & Connect Telegram" flow (telegram_link_sessions).
    // On create there's no existing row to fall back to, so a missing/invalid value just
    // means "not connected yet" rather than a hard error.
    const { value: telegramChatIdValue, error: telegramChatIdError } = parseTelegramChatId(
      req.body.telegram_chat_id
    );
    if (telegramChatIdError) return res.status(400).json({ error: telegramChatIdError });

    const map = (req.body.map || '').trim() || null;
    const hoursResult = parseHours(req.body.hours);
    if (hoursResult.error) return res.status(400).json({ error: hoursResult.error });

    const closedResult = parseClosedDates(req.body.closedDates);
    if (closedResult.error) return res.status(400).json({ error: closedResult.error });

    // --- Image rows ---
    const rowsMetaResult = parseImageRowsMeta(req.body.image_rows_meta);
    if (rowsMetaResult.error) return res.status(400).json({ error: rowsMetaResult.error });

    const newFilesByRow = groupNewFilesByRow(req.files);

    let imageRows = [];
    try {
      imageRows = await buildImageRows(rowsMetaResult.value, newFilesByRow, slug);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    const result = await zingoPool.query(
      `INSERT INTO "booking_pages" (
         "merchant_id", "name", "slug", "image_rows",
         "phone", "telegram", "telegram_chat_id", "map_url", "opening_hours", "closed_dates",
         "category", "service_types"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING "id", "slug"`,
      [
        merchantId,
        name,
        slug,
        JSON.stringify(imageRows),
        phoneValue,
        telegramValue,
        telegramChatIdValue ?? null,
        map,
        JSON.stringify(hoursResult.value),
        JSON.stringify(closedResult.value),
        category,
        JSON.stringify(serviceTypesResult.value),
      ]
    );

    return res.status(201).json({
      message: 'Booking page created.',
      data: { id: result.rows[0].id, slug: result.rows[0].slug, image_rows: imageRows },
    });
  } catch (error) {
    console.error('Error creating booking page:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'That link is already in use. Please choose another.' });
    }
    return res.status(500).json({ error: 'Failed to create booking page. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /booking-settings/:id  — edit booking page (blocked once plan limit is hit)
// ---------------------------------------------------------------------------

router.put('/booking-settings/:id', authenticateFirebaseToken, handleBookingMulter, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    if (!merchantId) return res.status(401).json({ error: 'Unauthorized.' });

    const pageId = Number(req.params.id);
    if (!Number.isInteger(pageId)) return res.status(400).json({ error: 'Invalid page id.' });

    const existing = await getPageForMerchant(pageId, merchantId);
    if (!existing) return res.status(404).json({ error: 'Booking page not found.' });

    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    // Validate client-provided slug (excluding the current page ID from uniqueness check)
    const rawSlug = (req.body.slug || '').trim();
    const slug = slugify(rawSlug || name);

    if (!slug || slug.length < 3) {
      return res.status(400).json({ error: 'Booking URL handle must be at least 3 characters long.' });
    }
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'Booking URL handle can only contain lowercase letters, numbers, and hyphens.' });
    }

    const collision = await zingoPool.query(
      `SELECT 1 FROM "booking_pages" WHERE "slug" = $1 AND "id" <> $2 LIMIT 1`,
      [slug, pageId]
    );
    if (collision.rowCount > 0) {
      return res.status(400).json({ error: `The link "${slug}" is already taken. Please choose another.` });
    }

    const category = (req.body.category || '').trim().toLowerCase();
    const serviceTypesResult = parseServiceTypes(req.body.service_types);
    const { value: phoneValue, error: phoneError } = parsePhoneInput(req.body.phone);
    if (phoneError) return res.status(400).json({ error: phoneError });

    const { value: telegramValue, error: telegramError } = parseTelegramInput(req.body.telegram);
    if (telegramError) return res.status(400).json({ error: telegramError });

    // Chat id captured from the "Verify & Connect Telegram" flow.
    // If the field wasn't sent at all (value === undefined), keep whatever is already
    // saved on the page instead of wiping it out on an unrelated edit. If it was sent
    // as an empty string, that's an explicit disconnect -> store null.
    const { value: telegramChatIdParsed, error: telegramChatIdError } = parseTelegramChatId(
      req.body.telegram_chat_id
    );
    if (telegramChatIdError) return res.status(400).json({ error: telegramChatIdError });
    const telegramChatIdValue =
      telegramChatIdParsed === undefined ? existing.telegram_chat_id ?? null : telegramChatIdParsed;

    const map = (req.body.map || '').trim() || null;
    const hoursResult = parseHours(req.body.hours);
    if (hoursResult.error) return res.status(400).json({ error: hoursResult.error });

    const closedResult = parseClosedDates(req.body.closedDates);
    if (closedResult.error) return res.status(400).json({ error: closedResult.error });

    // --- Image rows ---
    const rowsMetaResult = parseImageRowsMeta(req.body.image_rows_meta);
    if (rowsMetaResult.error) return res.status(400).json({ error: rowsMetaResult.error });

    // existing image gallery, whichever shape it's currently stored in
    // (new image_rows column, or the legacy flat image_paths column).
    const existingImageRows = normalizeImageRows(existing);
    const previousPaths = flattenImageRowPaths(existingImageRows);
    const newFilesByRow = groupNewFilesByRow(req.files);

    let imageRows = [];
    try {
      imageRows = await buildImageRows(rowsMetaResult.value, newFilesByRow, slug);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    const keptPaths = flattenImageRowPaths(imageRows);
    const removedImagePaths = previousPaths.filter((url) => !keptPaths.includes(url));
    if (removedImagePaths.length) {
      cleanupRemovedImages(removedImagePaths);
    }

    const result = await zingoPool.query(
      `UPDATE "booking_pages"
       SET "name" = $1, "slug" = $2, "image_rows" = $3, "phone" = $4, "telegram" = $5,
           "telegram_chat_id" = $6, "map_url" = $7, "opening_hours" = $8, "closed_dates" = $9,
           "category" = $10, "service_types" = $11, "updated_at" = now()
       WHERE "id" = $12 AND "merchant_id" = $13
       RETURNING "id", "slug"`,
      [
        name,
        slug,
        JSON.stringify(imageRows),
        phoneValue,
        telegramValue,
        telegramChatIdValue,
        map,
        JSON.stringify(hoursResult.value),
        JSON.stringify(closedResult.value),
        category,
        JSON.stringify(serviceTypesResult.value),
        pageId,
        merchantId,
      ]
    );

    return res.status(200).json({
      message: 'Booking page saved.',
      data: { id: result.rows[0].id, slug: result.rows[0].slug, image_rows: imageRows },
    });
  } catch (error) {
    console.error('Error saving booking page:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'That link is already in use. Please choose another.' });
    }
    return res.status(500).json({ error: 'Failed to save booking page. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /booking-settings/:id  — remove a page (frees a slot on the plan)
// ---------------------------------------------------------------------------
router.delete('/booking-settings/:id', authenticateFirebaseToken, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    if (!merchantId) return res.status(401).json({ error: 'Unauthorized.' });

    const pageId = Number(req.params.id);
    if (!Number.isInteger(pageId)) return res.status(400).json({ error: 'Invalid page id.' });

    const existing = await getPageForMerchant(pageId, merchantId);
    if (!existing) return res.status(404).json({ error: 'Booking page not found.' });

    // Clean up every image across every row (new image_rows shape or legacy
    // flat image_paths, whichever this page currently has).
    const removed = flattenImageRowPaths(normalizeImageRows(existing));
    if (removed.length) {
      cleanupRemovedImages(removed);
    }

    await zingoPool.query(`DELETE FROM "booking_pages" WHERE "id" = $1 AND "merchant_id" = $2`, [
      pageId,
      merchantId,
    ]);

    return res.status(200).json({ message: 'Booking page deleted.' });
  } catch (error) {
    console.error('Error deleting booking page:', error);
    return res.status(500).json({ error: 'Failed to delete booking page.' });
  }
});




router.get('/booking/availability', async (req, res) => {
  const { pageId, date, sectionId, serviceTypeId } = req.query;
  console.log("req query", req.query)

  if (!pageId || !date) {
    return res.status(400).json({ error: 'pageId and date are required.' });
  }

  try {
    const pageResult = await zingoPool.query(
      `SELECT opening_hours, max_capacity_per_slot FROM booking_pages WHERE id = $1`,
      [pageId]
    );
    const page = pageResult.rows[0];
    if (!page) return res.status(404).json({ error: 'Page not found.' });

    const dayKey = ['sun','mon','tue','wed','thu','fri','sat'][new Date(`${date}T00:00:00`).getDay()];
   const dayHours = page.opening_hours?.[dayKey];
    if (getSlots(dayHours).length === 0) {
      return res.json({ slots: [] });
    }
    // Whole-day manual block (section-specific or blanket)
    const dayBlockResult = await zingoPool.query(
      `SELECT 1 FROM blocked_slots
       WHERE booking_page_id = $1 AND block_date = $2 AND block_time IS NULL
         AND (section_id IS NULL OR section_id = $3)
       LIMIT 1;`,
      [pageId, date, sectionId || null]
    );
    if (dayBlockResult.rowCount > 0) {
      return res.json({ slots: [] });
    }

    // Per-slot manual blocks for this date
    const slotBlocksResult = await zingoPool.query(
      `SELECT block_time FROM blocked_slots
       WHERE booking_page_id = $1 AND block_date = $2 AND block_time IS NOT NULL
         AND (section_id IS NULL OR section_id = $3);`,
      [pageId, date, sectionId || null]
    );
    const blockedTimes = new Set(slotBlocksResult.rows.map((r) => r.block_time.slice(0, 5)));

    // Existing bookings occupying slots (pending + confirmed count against capacity)
    const bookingsResult = await zingoPool.query(
      `SELECT start_time, COUNT(*)::int AS count
       FROM bookings
       WHERE booking_page_id = $1
         AND booking_date = $2
         AND status IN ('pending', 'confirmed')
         AND ($3::text IS NULL OR section_id = $3)
         AND ($4::text IS NULL OR service_type_id = $4)
       GROUP BY start_time;`,
      [pageId, date, sectionId || null, serviceTypeId || null]
    );
    const bookedCounts = new Map(
      bookingsResult.rows.map((r) => [r.start_time.slice(0, 5), r.count])
    );

   const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toTime = (mins) => {
    const wrapped = mins % 1440; // handles shifts that run past midnight
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };

  const maxPerSlot = page.max_capacity_per_slot ?? Infinity;
  const seen = new Set();
  const slots = [];

  const ranges = [...getSlots(dayHours)].sort((a, b) => a.open.localeCompare(b.open));

  for (const range of ranges) {
    const start = toMinutes(range.open);
    let end = toMinutes(range.close);
    if (end <= start) end += 1440; // e.g. 18:00–02:00

    for (let m = start; m < end; m += 30) {
      const time = toTime(m);
      if (seen.has(time)) continue; // guard against overlapping ranges
      seen.add(time);

      const bookedCount = bookedCounts.get(time) || 0;
      const manuallyBlocked = blockedTimes.has(time);
      const full = bookedCount >= maxPerSlot;

      slots.push({ time, available: !manuallyBlocked && !full });
    }
  }

  return res.json({ slots });
  } catch (err) {
    console.error('Availability error:', err);
    return res.status(500).json({ error: 'Could not load availability.' });
  }
});

router.post('/booking-settings/:id/blocked-slots', authenticateFirebaseToken, async (req, res) => {
  const merchantId = req.user?.id;
  const pageId = Number(req.params.id);
  const { date, time, sectionId, reason } = req.body;

  const page = await getPageForMerchant(pageId, merchantId);
  if (!page) return res.status(404).json({ error: 'Booking page not found.' });
  if (!date) return res.status(400).json({ error: 'date is required.' });

  const result = await zingoPool.query(
    `INSERT INTO blocked_slots (booking_page_id, section_id, block_date, block_time, reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
    [pageId, sectionId || null, date, time || null, reason || null]
  );

  res.status(201).json({ blockedSlot: result.rows[0] });
});

// Unblock
router.delete('/booking-settings/:id/blocked-slots/:blockId', authenticateFirebaseToken, async (req, res) => {
  const merchantId = req.user?.id;
  const pageId = Number(req.params.id);

  const page = await getPageForMerchant(pageId, merchantId);
  if (!page) return res.status(404).json({ error: 'Booking page not found.' });

  await zingoPool.query(
    `DELETE FROM blocked_slots WHERE id = $1 AND booking_page_id = $2;`,
    [req.params.blockId, pageId]
  );

  res.status(200).json({ message: 'Unblocked.' });
});

// List blocks for a date range (for calendar UI)
router.get('/booking-settings/:id/blocked-slots', authenticateFirebaseToken, async (req, res) => {
  const merchantId = req.user?.id;
  const pageId = Number(req.params.id);

  const page = await getPageForMerchant(pageId, merchantId);
  if (!page) return res.status(404).json({ error: 'Booking page not found.' });

  const result = await zingoPool.query(
    `SELECT * FROM blocked_slots WHERE booking_page_id = $1 ORDER BY block_date, block_time;`,
    [pageId]
  );

  res.status(200).json({ blockedSlots: result.rows });
});


router.post('/booking/create', async (req, res) => {
  const {
    pageId, anonId, sectionId, serviceTypeId, guests, date, time, fullName, contact, note,
    telegramInitData,
  } = req.body;
  const telegramWriteAccess = true;
  console.log("Req body in creatng booking", req.body);
  console.log("telegramWriteAccess", telegramWriteAccess);

  if (!pageId || !guests || !date || !time || !fullName || !contact) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Only set when the request carries a valid, signed Telegram Mini App payload.
  const tgUser = getVerifiedTelegramUser(telegramInitData);
  const customerChatId = tgUser?.id ? String(tgUser.id) : null;

  const client = await zingoPool.connect();
  let inTransaction = false;

  try {
    const pageResult = await client.query(`SELECT * FROM booking_pages WHERE id = $1 LIMIT 1`, [pageId]);
    const page = pageResult.rows[0];

    if (!page || !page.is_active) {
      return res.status(400).json({ error: 'This page is not accepting bookings.' });
    }

    // No chat connected = nobody would ever see the request.
    if (!page.telegram_chat_id) {
      return res.status(409).json({ error: 'This venue has not connected Telegram yet.' });
    }

    await client.query('BEGIN');
    inTransaction = true;

    const bookingResult = await client.query(
      `INSERT INTO bookings
         (booking_page_id, section_id, service_type_id, guests, booking_date, start_time,
          full_name, phone, note, anon_id, telegram_chat_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *;`,
      [
        page.id,
        sectionId || null,
        serviceTypeId || null,
        guests,
        date,
        time,
        fullName.trim(),
        contact.trim(),
        note ? note.trim() : null,
        anonId,
        customerChatId,
      ]
    );
    const booking = bookingResult.rows[0];

    await client.query(
      `INSERT INTO booking_events (booking_id, type, payload, actor) VALUES ($1,$2,$3,$4);`,
      [booking.id, 'created', JSON.stringify(booking), 'customer']
    );

    // Set after the event insert so it isn't stored in the payload
    booking.service_label = resolveServiceLabel(page, booking);

    const text = buildMerchantBookingText(booking, "🔔 New booking request", {
      requestedAt: formatRequestedAt(),
    });

    // Notify the venue BEFORE committing — roll back if the venue never got it.
    let telegramMessageId = null;
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${process.env.MERCHANT_TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: page.telegram_chat_id,
          text,
          parse_mode: 'HTML',
          reply_markup: PENDING_KEYBOARD(booking.id),
        }),
      });
      const tgData = await tgRes.json().catch(() => null);

      if (!tgRes.ok || !tgData?.ok) {
        console.error('Telegram notification rejected:', tgData);
        throw new Error('telegram_send_failed');
      }
      telegramMessageId = tgData.result?.message_id ? String(tgData.result.message_id) : null;
    } catch (tgErr) {
      console.error('Telegram notification error:', tgErr);
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(502).json({ error: "Couldn't reach the venue right now. Please try again." });
    }

    if (telegramMessageId) {
      await client.query(`UPDATE bookings SET telegram_message_id = $1 WHERE id = $2`, [telegramMessageId, booking.id]);
      booking.telegram_message_id = telegramMessageId;
    }

    await client.query('COMMIT');
    inTransaction = false;
    let notified = false;

    // Booking is safely stored. Now send the customer their receipt (best effort).
   if (customerChatId && telegramWriteAccess) {
  const keyboard = buildBookingKeyboard({
    id: booking.id,
    business_name: page.name,
    merchant_telegram: page.telegram,
    merchant_chat_id: page.telegram_chat_id,
  });

  notified = await sendCustomerReceipt(
    customerChatId,
    `📩 Booking request received\n` +
      `⏳ Status: Pending confirmation\n` +
      `――――――――――――――――\n\n` +
      `${page.name ? `🏬 ${page.name}\n` : ''}` +
      `👥 Guests: ${booking.guests}\n` +
      `📅 Date: ${formatBookingDate(booking.booking_date)}\n` +
      `⏰ Time: ${formatBookingTime(booking.start_time)}\n\n` +
      `The venue hasn't confirmed yet. We'll message you here as soon as they accept or decline.`,
    keyboard
  );
  await zingoPool.query(
    `UPDATE bookings SET telegram_notify_ok = $1 WHERE id = $2`,
    [notified, booking.id]
  );
}

    return res.status(201).json({ booking, notifications: notified });
  } catch (err) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    console.error('Booking create error:', err);
    return res.status(500).json({ error: 'Could not create booking.' });
  } finally {
    client.release(); // runs exactly once, on every path
  }
});
module.exports = router;