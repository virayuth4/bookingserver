const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const multer = require("multer");
const { uploadMediaFilesToS3, deleteFileFromS3, createPresignedUpload, getCdnUrl, EXT_BY_MIME } = require("../../../database/s3");
const { parseTelegramInput } = require("../../../lib/parsers");
const zingoPool = require("../../../database/pgZingo");
const { requireAuth } = require("../telegram/session");
const { parsePriceInput } = require("../../../utils/parsePriceInput");

const MAX_IMAGES_PER_ROW = 30;     // photos + videos together
const MAX_TOTAL_IMAGES = 40;       // photos + videos across all rows
const MAX_TOTAL_VIDEOS = 3;        // keep this low, videos are big
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // 10MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;  // 50MB
const VIDEO_URL_RE = /\.(mp4|m4v|mov|webm)(\?.*)?$/i;

const MEDIA_PREFIX = "eatdoko/ev-listings";
const ownPrefix = (userId) => getCdnUrl(`${MEDIA_PREFIX}/${userId}/`);

const isVideoFile = (file) => file.mimetype?.startsWith('video/');
const isImageFile = (file) => file.mimetype?.startsWith('image/');
const isVideoUrl = (url) => typeof url === 'string' && VIDEO_URL_RE.test(url);

const ALLOWED_VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime'];

// Best-effort S3 cleanup. Never throws, so it can't break a response.
// Adjust the call if deleteFileFromS3 expects a key instead of a full URL.
async function deleteMediaFromS3(urls) {
  if (!urls.length) return;
  const results = await Promise.allSettled(urls.map((url) => deleteFileFromS3(url)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error('S3 delete failed:', urls[i], r.reason);
  });
}

function parsePhoneInput(phone) {
  const value = (phone || '').trim();
  if (!value) return { value: null };
  if (!/^\+?[0-9\s\-().]{6,20}$/.test(value)) {
    return { error: 'Phone number is invalid.' };
  }
  return { value };
}

const SOCIAL_HOSTS = ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'instagr.am'];

function parseSocialInput(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { value: null };
  if (value.length > 200) return { error: 'Social link is too long.' };

  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const u = new URL(candidate);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) throw new Error();
    return { value: u.href };
  } catch {
    return { error: 'Enter a valid Facebook or Instagram link.' };
  }
}

async function uploadFilesPreservingOrder(files, slug) {
  const imageIdx = [];
  const videoIdx = [];
  files.forEach((f, i) => (isVideoFile(f) ? videoIdx : imageIdx).push(i));

  const [imageUrls, videoUrls] = await Promise.all([
    imageIdx.length
      ? uploadMediaFilesToS3(imageIdx.map((i) => files[i]), slug, 'image', {
          pathPrefix: 'eatdoko/booking-pages/gallery',
        })
      : [],
    videoIdx.length
      ? uploadMediaFilesToS3(videoIdx.map((i) => files[i]), slug, 'video', {
          pathPrefix: 'eatdoko/booking-pages/gallery',
        })
      : [],
  ]);

  const ordered = new Array(files.length);
  imageIdx.forEach((origIdx, k) => { ordered[origIdx] = imageUrls[k]; });
  videoIdx.forEach((origIdx, k) => { ordered[origIdx] = videoUrls[k]; });
  return ordered;
}
// ---------------------------------------------------------------------------
// Slug: generated once, on create, from crypto. Never derived from user input
// and never changed afterwards, so public links stay stable.
// ---------------------------------------------------------------------------
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_LENGTH = 10; // 36^10 ≈ 3.6 quadrillion combinations
const SLUG_MAX_ATTEMPTS = 5;

function randomSlug() {
  let out = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    out += SLUG_ALPHABET[crypto.randomInt(SLUG_ALPHABET.length)];
  }
  return out;
}

async function generateUniqueSlug() {
  for (let i = 0; i < SLUG_MAX_ATTEMPTS; i++) {
    const slug = randomSlug();
    const { rowCount } = await zingoPool.query(
      `SELECT 1 FROM "ev_listings" WHERE "slug" = $1 LIMIT 1`,
      [slug]
    );
    if (rowCount === 0) return slug;
  }
  throw new Error('Could not generate a unique listing link.');
}

// ---------------------------------------------------------------------------
// Validation constants (keep in sync with lib/evConstants.js on the frontend)
// ---------------------------------------------------------------------------
const CONDITIONS = ['new', 'used', 'certified'];
const STATUSES = ['available', 'reserved', 'sold'];
const DRIVETRAINS = ['fwd', 'rwd', 'awd'];
const CONNECTORS = ['ccs2', 'ccs1', 'gbt', 'chademo', 'nacs', 'type2', 'type1', 'unknown'];
const RANGE_STANDARDS = ['wltp', 'cltc', 'epa', 'nedc', 'real'];
const CHEMISTRIES = ['lfp', 'nmc', 'other'];
const SELLER_TYPES = ['dealer', 'private'];
const SERVICE_HISTORY = ['full', 'partial', 'none'];
const CURRENCIES = ['USD', 'KHR', 'THB', 'VND', 'EUR'];
const BODY_TYPES = [
  'Sedan', 'SUV', 'Hatchback', 'Crossover', 'Wagon', 'Coupe',
  'Convertible', 'Pickup truck', 'Van / MPV', 'Microcar / City car',
];
const ENGINES = ['electric', 'hybrid', 'erev'];


const ENUM_FIELDS = {
  engine: ENGINES,
  condition: CONDITIONS,
  body_type: BODY_TYPES,
  currency: CURRENCIES,
  service_history: SERVICE_HISTORY,
  battery_chemistry: CHEMISTRIES,
  range_standard: RANGE_STANDARDS,
  connector: CONNECTORS,
  drivetrain: DRIVETRAINS,
  seller_type: SELLER_TYPES,
};

const NUM_FIELDS = {
  year:                   { min: 2008, max: new Date().getFullYear() + 1, int: true },
  seats:                  { min: 1, max: 9, int: true },
  mileage_km:             { min: 0, max: 2_000_000, int: true },
  owners:                 { min: 0, max: 20, int: true },
  battery_kwh:            { min: 1, max: 300 },
  battery_health_pct:     { min: 1, max: 100 },
  range_km:               { min: 1, max: 2000, int: true },
  battery_warranty_years: { min: 0, max: 30 },
  battery_warranty_km:    { min: 0, max: 1_000_000, int: true },
  warranty_years:         { min: 0, max: 30 },   
  ac_charge_kw:           { min: 0, max: 350 },
  dc_charge_kw:           { min: 0, max: 1500 },
  charge_10_80_min:       { min: 1, max: 600, int: true },
  power_kw:               { min: 1, max: 2000 },
  torque_nm:              { min: 1, max: 5000 },
  zero_to_100:            { min: 1, max: 60 },
  top_speed_kmh:          { min: 20, max: 500, int: true },
};

const TEXT_FIELDS = {
  make: 50,
  model: 80,
  trim: 80,
  exterior_color: 40,
  interior_color: 40,
  location: 120,
  description: 2000,
};

const BOOL_FIELDS = ['negotiable', 'accident_free'];

const FIELD_LABELS = {
  year: 'Model year',
  seats: 'Seats',
  price: 'Price',
  mileage_km: 'Mileage',
  owners: 'Previous owners',
  battery_kwh: 'Battery capacity',
  battery_health_pct: 'Battery health',
  range_km: 'Range',
  battery_warranty_years: 'Battery warranty (years)',
  battery_warranty_km: 'Battery warranty (km)',
  ac_charge_kw: 'AC charging power',
  dc_charge_kw: 'DC charging power',
  charge_10_80_min: '10–80% charge time',
  power_kw: 'Motor power',
  torque_nm: 'Torque',
  zero_to_100: '0–100 km/h',
  top_speed_kmh: 'Top speed',
  warranty_years: 'Vehicle warranty', 
};

const VIN_RE = /^[A-Z0-9]{5,17}$/;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------


function parseImageRows(raw, userId, previousSet) {
  let parsed;
  try { parsed = JSON.parse(raw || "[]"); } catch { return { error: "Invalid image rows data." }; }
  if (!Array.isArray(parsed)) return { error: "Invalid image rows data." };

  const value = [];
  let total = 0;
  let videos = 0;

  for (const row of parsed) {
    const label = String(row?.label || "").trim();
    if (!label) return { error: "Each photo row needs a name." };

    const paths = Array.isArray(row?.image_paths) ? row.image_paths.filter((u) => typeof u === "string") : [];
    if (paths.length > MAX_IMAGES_PER_ROW) {
      return { error: `"${label}" can have up to ${MAX_IMAGES_PER_ROW} photos/videos.` };
    }
    for (const url of paths) {
      if (!previousSet.has(url) && !url.startsWith(ownPrefix(userId))) {
        return { error: "Invalid media in photo rows." };
      }
      if (isVideoUrl(url)) videos++;
    }
    total += paths.length;
    value.push({ label, image_paths: paths });
  }

  if (total > MAX_TOTAL_IMAGES) return { error: `You can upload up to ${MAX_TOTAL_IMAGES} photos/videos in total.` };
  if (videos > MAX_TOTAL_VIDEOS) return { error: `You can add up to ${MAX_TOTAL_VIDEOS} videos in total.` };
  return { value };
}
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
  const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

  // ---- Validate everything BEFORE uploading anything to S3 ----
  let totalCount = 0;
  let totalVideos = 0;

  for (let idx = 0; idx < rowsMeta.length; idx++) {
    const { label, existing_image_paths: existing } = rowsMeta[idx];
    const newFiles = newFilesByRow.get(idx) || [];

    if (existing.length + newFiles.length > MAX_IMAGES_PER_ROW) {
      throw badRequest(`"${label}" can have up to ${MAX_IMAGES_PER_ROW} photos/videos.`);
    }

    for (const file of newFiles) {
      if (!isImageFile(file) && !isVideoFile(file)) {
        throw badRequest(`"${file.originalname}" is not a supported photo or video.`);
      }
      if (isImageFile(file) && file.size > MAX_IMAGE_BYTES) {
        throw badRequest(`Photo "${file.originalname}" is larger than ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`);
      }
      if (isVideoFile(file) && file.size > MAX_VIDEO_BYTES) {
        throw badRequest(`Video "${file.originalname}" is larger than ${MAX_VIDEO_BYTES / 1024 / 1024}MB.`);
      }
    }

    totalCount += existing.length + newFiles.length;
    totalVideos +=
      existing.filter(isVideoUrl).length + newFiles.filter(isVideoFile).length;
  }

  if (totalCount > MAX_TOTAL_IMAGES) {
    throw badRequest(`You can upload up to ${MAX_TOTAL_IMAGES} photos/videos in total.`);
  }
  if (totalVideos > MAX_TOTAL_VIDEOS) {
    throw badRequest(`You can add up to ${MAX_TOTAL_VIDEOS} videos in total.`);
  }

  // ---- Upload ----
  const imageRows = [];
  for (let idx = 0; idx < rowsMeta.length; idx++) {
    const { label, existing_image_paths: existing } = rowsMeta[idx];
    const newFiles = newFilesByRow.get(idx) || [];

    const uploaded = newFiles.length ? await uploadFilesPreservingOrder(newFiles, slug) : [];
    imageRows.push({ label, image_paths: [...existing, ...uploaded] });
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
  const legacy = parseJsonField(page.image_paths, []).filter((u) => typeof u === 'string');
  return legacy.length ? [{ label: 'Photos', image_paths: legacy }] : [];
}

// Takes the JSON string from req.body.car. Returns { value } or { error }.
function parseCar(raw) {
  console.log("parseCar", raw)
  let input;
  try {
    input = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { error: 'Car details are not valid JSON.' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Car details are required.' };
  }

  const car = {};

  // Text
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    const v = String(input[field] ?? '').trim();
    if (v.length > max) return { error: `${field.replace(/_/g, ' ')} is too long (max ${max} characters).` };
    car[field] = v || null;
  }


// Numbers (null when blank)
for (const [field, rule] of Object.entries(NUM_FIELDS)) {
  const v = input[field];
  if (v === null || v === undefined || v === '') {
    car[field] = null;
    continue;
  }
  const n = Number(v);
  const label = FIELD_LABELS[field] || field;
  if (!Number.isFinite(n)) return { error: `${label} must be a number.` };
  if (rule.int && !Number.isInteger(n)) return { error: `${label} must be a whole number.` };
  if (n < rule.min || n > rule.max) {
    return { error: `${label} must be between ${rule.min} and ${rule.max}.` };
  }
  car[field] = n;
}

  // Enums (null when blank)
  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    const v = String(input[field] ?? '').trim();
    if (!v) {
      car[field] = null;
      continue;
    }
    if (!allowed.includes(v)) return { error: `Invalid value for ${field.replace(/_/g, ' ')}.` };
    car[field] = v;
  }

  // Booleans
  for (const field of BOOL_FIELDS) car[field] = input[field] === true || input[field] === 'true';

  // VIN
  const vin = String(input.vin ?? '').trim().toUpperCase();
  if (vin && !VIN_RE.test(vin)) return { error: 'VIN must be 5–17 letters and numbers.' };
  car.vin = vin || null;

  // Contact details (public handle only, not a bot chat id)
  const phone = parsePhoneInput(input.phone);
  if (phone.error) return { error: phone.error };
  car.phone = phone.value ?? null;

  const social = parseSocialInput(input.social);
  if (social.error) return { error: social.error };
  car.social = social.value;

  const telegram = parseTelegramInput(input.telegram);
  if (telegram.error) return { error: telegram.error };
  car.telegram = telegram.value ?? null;

  const map = String(input.map ?? '').trim();
  if (map) {
    try {
      const u = new URL(map);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch {
      return { error: 'Map link must be a valid http(s) URL.' };
    }
  }
  car.map = map || null;

  // --- Required fields ---
  if (!car.make) return { error: 'Make is required.' };
  if (!car.model) return { error: 'Model is required.' };
  if (car.year === null) return { error: 'Model year is required.' };
  if (car.battery_kwh === null) return { error: 'Battery capacity is required.' };
  if (car.range_km === null) return { error: 'Range is required.' };

  if (!car.condition) car.condition = 'used';
  if (!car.currency) car.currency = 'USD';
  if (!car.seller_type) car.seller_type = 'dealer';
  if (!car.range_standard) car.range_standard = 'wltp';
  if (!car.connector) car.connector = 'unknown';
  if (!car.engine) car.engine = 'electric';

const priceInfo = parsePriceInput(input.price);
if (priceInfo.kind === 'empty') return { error: 'Price is required.' };
if (priceInfo.kind === 'invalid') {
  return { error: 'Price must be digits (350,000), digits then X (3X,XXX), or 0.' };
}
Object.assign(car, priceFields(priceInfo));


  // Mileage: required unless the car is new
  if (car.condition === 'new') {
    car.mileage_km = car.mileage_km ?? 0;
    // These only make sense for pre-owned cars
    car.battery_health_pct = null;
    car.owners = null;
    car.service_history = null;
    car.accident_free = false;
  } else if (car.mileage_km === null) {
    return { error: 'Mileage is required for used cars. Enter 0 for a brand-new car.' };
  }

  return { value: car };
}

function parseFeatures(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: [] };
  let list;
  try {
    list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { error: 'Features must be a JSON array.' };
  }
  if (!Array.isArray(list)) return { error: 'Features must be a list.' };
  if (list.length > 80) return { error: 'You can add up to 80 features.' };

  const seen = new Set();
  const out = [];
  for (const item of list) {
    const f = String(item ?? '').trim();
    if (!f) continue;
    if (f.length > 60) return { error: 'A feature name is too long (max 60 characters).' };
    const key = f.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return { value: out };
}

const buildTitle = (car) =>
  [car.year, car.make, car.model, car.trim].filter(Boolean).join(' ');

async function getListingForMerchant(listingId, merchantId) {
  const { rows } = await zingoPool.query(
    `SELECT * FROM "ev_listings" WHERE "id" = $1 AND "user_id" = $2 LIMIT 1`,
    [listingId, merchantId]
  );
  return rows[0] || null;
}

function priceFields(info) {
  if (info.kind === 'contact') {
    return { price: null, price_text: '0', masked_price: null, price_min: null, price_max: null };
  }
  return {
    price: info.kind === 'exact' ? info.value : null,
    price_text: info.text,
    masked_price: info.kind === 'masked' ? info.text : null,
    price_min: info.min,
    price_max: info.max,
  };
}

async function recordPriceIfChanged(db, listingId, p) {
  const { rows } = await db.query(
    `SELECT "price"::float8 AS "price", "price_text", "currency"
       FROM "ev_listing_prices"
      WHERE "listing_id" = $1
      ORDER BY "recorded_at" DESC, "id" DESC
      LIMIT 1`,
    [listingId]
  );
  const last = rows[0];

  const toN = (v) => (v === null || v === undefined ? null : Number(v));

  const unchanged =
    last &&
    toN(last.price) === toN(p.price) &&
    (last.price_text ?? '') === (p.price_text ?? '') &&
    last.currency === p.currency;
  if (unchanged) return;

  await db.query(
    `INSERT INTO "ev_listing_prices"
       ("listing_id", "price", "price_min", "price_max", "price_text", "currency")
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [listingId, p.price, p.price_min, p.price_max, p.price_text, p.currency]
  );
}

// Shared by POST and PUT so both validate identically.
// Returns { error: {status, message} } or { value: {...} }
// Note: no slug here. It's generated on create and never edited.
function parseListingBody(body) {
  const carResult = parseCar(body.car);
  if (carResult.error) return { error: { status: 400, message: carResult.error } };
  const car = carResult.value;

  const featuresResult = parseFeatures(body.features);
  if (featuresResult.error) return { error: { status: 400, message: featuresResult.error } };

  const status = (body.status || 'available').trim().toLowerCase();
  if (!STATUSES.includes(status)) return { error: { status: 400, message: 'Invalid listing status.' } };

  // Title is always built on the server so it can't drift from the specs.
const rawTitle = Array.isArray(body.title) ? body.title[0] : body.title;
const submittedTitle = String(rawTitle ?? '').replace(/\s+/g, ' ').trim();
if (submittedTitle.length > 100) {
  return { error: { status: 400, message: 'Listing title is too long (max 100 characters).' } };
}
const title = submittedTitle || buildTitle(car);

  return { value: { car, features: featuresResult.value, status, title } };
}

const bookingUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // multer has ONE size limit for all files, so use the larger (video) limit
    // here and enforce the smaller image limit manually in buildImageRows().
    fileSize: MAX_VIDEO_BYTES,
    files: MAX_TOTAL_IMAGES,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    if (ALLOWED_VIDEO_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only photos (PNG, JPG, WEBP) and videos (MP4, WEBM, MOV) are allowed.'));
  },
});

const handleBookingMulter = (req, res, next) => {
  bookingUpload.any()(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `Files are too large. Photos can be up to ${MAX_IMAGE_BYTES / 1024 / 1024}MB and videos up to ${MAX_VIDEO_BYTES / 1024 / 1024}MB.`,
        });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: `You can upload up to ${MAX_TOTAL_IMAGES} files at once.` });
      }
      return res.status(400).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message || 'Invalid upload.' });
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value; // json/jsonb columns come back already parsed
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Owner-scoped lookup: a user can only ever load their own listing
async function getListingForMerchant(listingId, userId) {
  const { rows } = await zingoPool.query(
    `SELECT "id", "slug", "title", "status", "car", "features", "image_rows"
       FROM "ev_listings"
      WHERE "id" = $1 AND "posted_by" = $2
      LIMIT 1`,
    [listingId, userId]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    car: parseJsonField(rows[0].car, {}),
    features: parseJsonField(rows[0].features, []),
    image_rows: parseJsonField(rows[0].image_rows, []),
  };
}

// ---------------------------------------------------------------------------
// GET /listings/id/:id — load one listing for the edit form
// ---------------------------------------------------------------------------
router.get('/listings/id/:id', requireAuth, async (req, res) => {
  console.log("get listing route hitget")
  try {
    console.log("GET /listings/id/:id", req.params.id);
    const userId = req.user?.id;
    console.log("userId", userId)
    if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

    const listingId = Number(req.params.id);
    if (!Number.isInteger(listingId) || listingId <= 0) {
      return res.status(400).json({ error: 'Invalid listing id.' });
    }

    const listing = await getListingForMerchant(listingId, userId);
    // Same 404 whether it doesn't exist or belongs to someone else
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });

    // Never cache: the edit form must always show the latest saved data
    res.set('Cache-Control', 'no-store');

    return res.status(200).json({
      data: {
        id: listing.id,
        slug: listing.slug,
        title: listing.title,
        status: listing.status,
        car: listing.car,
        features: listing.features,
        image_rows: normalizeImageRows(listing),
      },
    });
  } catch (error) {
    console.error('Error loading EV listing:', error);
    return res.status(500).json({ error: 'Failed to load listing.' });
  }
});

router.post("/uploads/presign", requireAuth, express.json(), async (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length || files.length > MAX_TOTAL_IMAGES) {
      return res.status(400).json({ error: `Send between 1 and ${MAX_TOTAL_IMAGES} files.` });
    }

    const out = [];
    for (const f of files) {
      const type = String(f?.type || "");
      const isVideo = ALLOWED_VIDEO_MIME.includes(type);
      const isImage = type.startsWith("image/") && EXT_BY_MIME[type];
      if (!isVideo && !isImage) return res.status(400).json({ error: "Unsupported file type." });

      const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (!Number.isFinite(f.size) || f.size <= 0 || f.size > limit) {
        return res.status(400).json({ error: `A file is larger than ${limit / 1024 / 1024}MB.` });
      }

      out.push(
        await createPresignedUpload({
          prefix: `${MEDIA_PREFIX}/${req.user.id}`,
          contentType: type,
        })
      );
    }
    return res.json({ data: out });
  } catch (err) {
    console.error("presign failed", err);
    return res.status(500).json({ error: "Could not prepare upload." });
  }
});

// ---------------------------------------------------------------------------
// POST /listings — create a new listing (blocked once plan limit is hit)
// ---------------------------------------------------------------------------
router.post('/listings', requireAuth, handleBookingMulter, async (req, res) => {
  try {
    const postedBy = req.user.id;

    const parsed = parseListingBody(req.body);
    if (parsed.error) return res.status(parsed.error.status).json({ error: parsed.error.message });
    const { car, features, status, title } = parsed.value;

    const rowsResult = parseImageRows(req.body.image_rows_meta, postedBy, new Set());
    if (rowsResult.error) return res.status(400).json({ error: rowsResult.error });
    const imageRows = rowsResult.value;

const slug = await generateUniqueSlug();

const client = await zingoPool.connect();
try {
  await client.query('BEGIN');

  const result = await client.query(
    `INSERT INTO "ev_listings" (
      "posted_by", "slug", "title", "status", "condition",
      "make", "model", "year", "price", "masked_price", "price_min", "price_max", "currency", "mileage_km",
      "battery_kwh", "range_km", "connector", "body_type",
      "car", "features", "image_rows"
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    RETURNING "id", "slug"`,
    [
      postedBy, slug, title, status, car.condition,
      car.make, car.model, car.year, car.price, car.masked_price, car.price_min, car.price_max,
      car.currency, car.mileage_km, car.battery_kwh, car.range_km, car.connector, car.body_type,
      JSON.stringify(car), JSON.stringify(features), JSON.stringify(imageRows),
    ]
  );

  await recordPriceIfChanged(client, result.rows[0].id, car);
  await client.query('COMMIT');

  return res.status(201).json({
    message: 'Listing created.',
    data: { id: result.rows[0].id, slug: result.rows[0].slug, image_rows: imageRows },
  });
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err; // your existing outer catch still handles 23505 and 500
} finally {
  client.release();
}
  } catch (error) {
    console.error('Error creating EV listing:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Something went wrong creating your listing link. Please try again.' });
    }
    return res.status(500).json({ error: 'Failed to create listing. Please try again.' });
  }
});
// ---------------------------------------------------------------------------
// PUT /listings/:id — edit a listing (slug never changes)
// ---------------------------------------------------------------------------
router.put('/listings/:id', requireAuth, handleBookingMulter, async (req, res) => {
  try {
    const postedBy = req.user?.id;
    if (!postedBy) return res.status(401).json({ error: 'Unauthorized.' });

    const listingId = Number(req.params.id);
    if (!Number.isInteger(listingId) || listingId <= 0) {
      return res.status(400).json({ error: 'Invalid listing id.' });
    }

    const existing = await getListingForMerchant(listingId, postedBy);
    if (!existing) return res.status(404).json({ error: 'Listing not found.' });

    const parsed = parseListingBody(req.body);
    if (parsed.error) return res.status(parsed.error.status).json({ error: parsed.error.message });
    const { car, features, status, title } = parsed.value;

    // ---- Price rules --------------------------------------------------------
    const saved = existing.car || {};

    // Currency is locked after creation so history stays comparable.
    car.currency = saved.currency || 'USD';

    // The form sends back the price it originally loaded. If the submitted price
    // is the same as that, the seller didn't touch it, so keep what is stored now.
    // This stops a stale form from overwriting a newer price.
    // If original_price is missing or unreadable, treat the price as touched.
    const originalInfo = parsePriceInput(req.body.original_price);
    const originalUsable = originalInfo.kind !== 'empty' && originalInfo.kind !== 'invalid';
    const priceTouched =
      !originalUsable || priceFields(originalInfo).price_text !== car.price_text;

    if (!priceTouched) {
      Object.assign(car, {
        price: saved.price ?? null,
        price_text: saved.price_text ?? null,
        masked_price: saved.masked_price ?? null,
        price_min: saved.price_min ?? null,
        price_max: saved.price_max ?? null,
      });
    }

    // ---- Media --------------------------------------------------------------
    const previousPaths = flattenImageRowPaths(normalizeImageRows(existing));
    const previousSet = new Set(previousPaths);

    const rowsResult = parseImageRows(req.body.image_rows_meta, postedBy, previousSet);
    if (rowsResult.error) return res.status(400).json({ error: rowsResult.error });
    const imageRows = rowsResult.value;

    const keptSet = new Set(flattenImageRowPaths(imageRows));
    const removedPaths = previousPaths.filter((url) => !keptSet.has(url));

    // ---- Save + price history in one transaction -----------------------------
    const client = await zingoPool.connect();
    let saveResult;
    try {
      await client.query('BEGIN');

      saveResult = await client.query(
        `UPDATE "ev_listings"
            SET "title"=$1, "status"=$2, "condition"=$3,
                "make"=$4, "model"=$5, "year"=$6,
                "price"=$7, "masked_price"=$8, "price_min"=$9, "price_max"=$10, "currency"=$11,
                "mileage_km"=$12, "battery_kwh"=$13, "range_km"=$14, "connector"=$15,
                "body_type"=$16, "car"=$17, "features"=$18, "image_rows"=$19,
                "updated_at"=now()
          WHERE "id"=$20 AND "posted_by"=$21
          RETURNING "id", "slug"`,
        [
          title, status, car.condition,
          car.make, car.model, car.year,
          car.price, car.masked_price, car.price_min, car.price_max, car.currency,
          car.mileage_km, car.battery_kwh, car.range_km, car.connector, car.body_type,
          JSON.stringify(car), JSON.stringify(features), JSON.stringify(imageRows),
          listingId, postedBy,
        ]
      );

      if (saveResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Listing not found.' });
      }

      // Inserts a history row only if price, price text or currency changed
      await recordPriceIfChanged(client, listingId, car);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err; // handled by the outer catch below
    } finally {
      client.release();
    }

    // Only delete files after the transaction has committed
    deleteMediaFromS3(removedPaths); // fire-and-forget

    return res.status(200).json({
      message: 'Listing saved.',
      data: { id: saveResult.rows[0].id, slug: saveResult.rows[0].slug, image_rows: imageRows },
    });
  } catch (error) {
    console.error('Error saving EV listing:', error);
    return res.status(500).json({ error: 'Failed to save listing. Please try again.' });
  }
});
module.exports = router;