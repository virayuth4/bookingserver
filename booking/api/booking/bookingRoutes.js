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

// ---------------------------------------------------------------------------
// Booking page settings
// ---------------------------------------------------------------------------

const BOOKING_TABLE = 'booking_pages';
const MAX_GALLERY_IMAGES = 5;
const MAX_CLOSED_DATES = 366;
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PLAN_LIMITS = { basic: 1, pro: 10 };
const DEFAULT_PLAN = 'basic';

const bookingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const handleBookingMulter = bookingUpload.fields([
  { name: 'images', maxCount: MAX_GALLERY_IMAGES },
]);

function parseJsonField(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parseHours(raw) {
  const hours = parseJsonField(raw, undefined);
  if (!hours || typeof hours !== 'object') {
    return { error: 'Opening hours are required.' };
  }

  const clean = {};
  for (const key of DAY_KEYS) {
    const day = hours[key];
    if (!day || typeof day !== 'object') {
      return { error: `Missing opening hours for ${key}.` };
    }

    if (day.closed) {
      clean[key] = { closed: true, open: null, close: null };
      continue;
    }

    if (!TIME_RE.test(day.open || '') || !TIME_RE.test(day.close || '')) {
      return { error: `Set valid opening and closing times for ${key}, or mark it closed.` };
    }
    if (day.close <= day.open) {
      return { error: `Closing time must be after opening time for ${key}.` };
    }

    clean[key] = { closed: false, open: day.open, close: day.close };
  }

  return { value: clean };
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

function parseTelegramInput(telegram) {
  const value = (telegram || '').trim();
  if (!value) return { value: null };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: 'Telegram must be a valid URL (e.g. https://t.me/username).' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { error: 'Telegram must be a valid http(s) URL.' };
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

// ---------------------------------------------------------------------------
// GET /booking-settings  — list all of the current merchant's booking pages
// ---------------------------------------------------------------------------
router.get('/booking-settings', authenticateFirebaseToken, async (req, res) => {
  try {
    const merchantId = req.user?.id;
    if (!merchantId) return res.status(401).json({ error: 'Unauthorized.' });

    

    const [pagesResult, plan] = await Promise.all([
      zingoPool.query(
        `SELECT "id", "name", "slug", "image_paths", "phone", "telegram", "telegram_chat_id", "map_url",
                "opening_hours", "closed_dates", "created_at", "updated_at"
         FROM "booking_pages" WHERE "merchant_id" = $1 ORDER BY "created_at" ASC`,
        [merchantId]
      ),
      getMerchantPlan(merchantId),
    ]);

    return res.status(200).json({
      data: pagesResult.rows,
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
    const page = await getPageForMerchant(pageId, merchantId);
    if (!page) return res.status(404).json({ error: 'Booking page not found.' });

    return res.status(200).json({ data: page });
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

    return res.status(200).json({ data: page });
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

    const newImageFiles = req.files?.images || [];
    if (newImageFiles.length > MAX_GALLERY_IMAGES) {
      return res.status(400).json({ error: `You can upload up to ${MAX_GALLERY_IMAGES} photos.` });
    }

    let imagePaths = [];
    if (newImageFiles.length) {
      imagePaths = await uploadMediaFilesToS3(newImageFiles, slug, 'image', {
        pathPrefix: 'eatdoko/booking-pages/gallery',
      });
    }

    const result = await zingoPool.query(
      `INSERT INTO "booking_pages" (
         "merchant_id", "name", "slug", "image_paths",
         "phone", "telegram", "telegram_chat_id", "map_url", "opening_hours", "closed_dates",
         "category", "service_types"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING "id", "slug"`,
      [
        merchantId,
        name,
        slug,
        JSON.stringify(imagePaths),
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
      data: { id: result.rows[0].id, slug: result.rows[0].slug, image_paths: imagePaths },
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

    const existingImagePaths = parseExistingImagePaths(existing.image_paths);
    const keptImagePaths = parseExistingImagePaths(req.body.existing_image_paths);
    const removedImagePaths = existingImagePaths.filter((url) => !keptImagePaths.includes(url));

    const newImageFiles = req.files?.images || [];
    if (keptImagePaths.length + newImageFiles.length > MAX_GALLERY_IMAGES) {
      return res.status(400).json({ error: `You can upload up to ${MAX_GALLERY_IMAGES} photos.` });
    }

    let uploadedImagePaths = [];
    if (newImageFiles.length) {
      uploadedImagePaths = await uploadMediaFilesToS3(newImageFiles, slug, 'image', {
        pathPrefix: 'eatdoko/booking-pages/gallery',
      });
    }

    if (removedImagePaths.length) {
      cleanupRemovedImages(removedImagePaths);
    }

    const finalImagePaths = [...keptImagePaths, ...uploadedImagePaths];

    const result = await zingoPool.query(
      `UPDATE "booking_pages"
       SET "name" = $1, "slug" = $2, "image_paths" = $3, "phone" = $4, "telegram" = $5,
           "telegram_chat_id" = $6, "map_url" = $7, "opening_hours" = $8, "closed_dates" = $9,
           "category" = $10, "service_types" = $11, "updated_at" = now()
       WHERE "id" = $12 AND "merchant_id" = $13
       RETURNING "id", "slug"`,
      [
        name,
        slug,
        JSON.stringify(finalImagePaths),
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
      data: { id: result.rows[0].id, slug: result.rows[0].slug, image_paths: finalImagePaths },
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

    const removed = parseExistingImagePaths(existing.image_paths);
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
      `SELECT opening_hours, max_bookings_per_slot FROM booking_pages WHERE id = $1`,
      [pageId]
    );
    const page = pageResult.rows[0];
    if (!page) return res.status(404).json({ error: 'Page not found.' });

    const dayKey = ['sun','mon','tue','wed','thu','fri','sat'][new Date(`${date}T00:00:00`).getDay()];
    const dayHours = page.opening_hours?.[dayKey];

    if (!dayHours || dayHours.closed) {
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

    // Build 30-min slots across opening hours
    const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const toTime = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

    const slots = [];
    for (let m = toMinutes(dayHours.open); m < toMinutes(dayHours.close); m += 30) {
      const time = toTime(m);
      const bookedCount = bookedCounts.get(time) || 0;
      const manuallyBlocked = blockedTimes.has(time);
      const full = bookedCount >= page.max_bookings_per_slot;

      slots.push({ time, available: !manuallyBlocked && !full });
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
    pageId,
    anonId,
    sectionId,
    serviceTypeId,
    guests,
    date,
    time,
    fullName,
    contact,
    note,
  } = req.body;
  console.log("req body", req.body)

  if (!pageId || !guests || !date || !time || !fullName || !contact) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const client = await zingoPool.connect();

  try {
    // 1. Fetch booking page details
    const pageResult = await client.query(
      `SELECT * FROM booking_pages WHERE id = $1 LIMIT 1`,
      [pageId]
    );

    const page = pageResult.rows[0];

    if (!page || !page.is_active) {
      client.release();
      return res.status(400).json({ error: 'This page is not accepting bookings.' });
    }

    // 2. Start transaction
    await client.query('BEGIN');

    // Insert booking
    const insertBookingQuery = `
      INSERT INTO bookings (
        booking_page_id,
        section_id,
        service_type_id,
        guests,
        booking_date,
        start_time,
        full_name,
        phone,
        note,
        anon_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
    `;

    const bookingValues = [
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
    ];

    const bookingResult = await client.query(insertBookingQuery, bookingValues);
    const booking = bookingResult.rows[0];

    // Insert audit/history event
    await client.query(
      `
      INSERT INTO booking_events (booking_id, type, payload, actor)
      VALUES ($1, $2, $3, $4);
      `,
      [booking.id, 'created', JSON.stringify(booking), 'customer']
    );

    // Commit booking insertion before triggering external API (Telegram)
    await client.query('COMMIT');

    // 3. Resolve section and service type display names
    // Handles array of strings ['Indoor seating'] or array of objects [{ id: '...', name: '...' }]
    const sections = Array.isArray(page.sections) ? page.sections : [];
    const serviceTypes = Array.isArray(page.service_types) ? page.service_types : [];

    const sectionMatch = sections.find((s) => (typeof s === 'string' ? s === booking.section_id : s.id === booking.section_id));
    const sectionName = typeof sectionMatch === 'string' ? sectionMatch : sectionMatch?.name ?? '';

    const serviceMatch = serviceTypes.find((s) => (typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, '-') === booking.service_type_id || s === booking.service_type_id : s.id === booking.service_type_id));
    const serviceName = typeof serviceMatch === 'string' ? serviceMatch : serviceMatch?.name ?? '';

    const text =
      `📅 New booking request\n\n` +
      `${booking.full_name} — ${booking.guests} guest(s)\n` +
      `${booking.booking_date} at ${booking.start_time}` +
      (sectionName ? `\n${sectionName}` : '') +
      (serviceName ? ` · ${serviceName}` : '') +
      `\nContact: ${booking.phone}` +
      (booking.note ? `\nNote: ${booking.note}` : '');

    // 4. Send Telegram notification if chat ID exists
    let telegramMessageId = null;
    if (page.telegram_chat_id) {
      try {
        const tgRes = await fetch(
          `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: page.telegram_chat_id,
              text,
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Accept', callback_data: `accept:${booking.id}` },
                    { text: '❌ Decline', callback_data: `decline:${booking.id}` },
                  ],
                ],
              },
            }),
          }
        );

        const tgData = await tgRes.json();
        telegramMessageId = tgData?.result?.message_id ? String(tgData.result.message_id) : null;
      } catch (tgErr) {
        console.error('Telegram notification error:', tgErr);
      }
    }

    // 5. Update booking with Telegram message ID if available
    if (telegramMessageId) {
      await client.query(
        `UPDATE bookings SET telegram_message_id = $1 WHERE id = $2`,
        [telegramMessageId, booking.id]
      );
      booking.telegram_message_id = telegramMessageId;
    }

    client.release();
    return res.status(201).json({ booking });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('Booking create error:', err);
    return res.status(500).json({ error: 'Could not create booking.' });
  }
});
module.exports = router;