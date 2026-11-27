const express = require("express");
const router = express.Router();
const { uploadMediaFilesToS3, deleteFileFromS3 } = require("../../../database/s3");
const zingoPool = require("../../../database/pgZingo");
const { requireAuth } = require("../telegram/session");

// Statuses a seller can switch between. Keep in sync with your DB
// (CHECK constraint / enum) and with STATUS_OPTIONS in MyListings.jsx.
const LISTING_STATUSES = ['available', 'reserved', 'sold'];

const SORTS = {
  newest: 'bumped_at DESC, id DESC',
  price_asc: 'price ASC NULLS LAST, id DESC',
  price_desc: 'price DESC NULLS LAST, id DESC',
  range_desc: 'range_km DESC NULLS LAST, id DESC',
  year_desc: 'year DESC NULLS LAST, id DESC',
};

const num = (v) => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const ADMIN_USER_ID = 1;
function requireAdmin(req, res, next) {
  if (Number(req.user && req.user.id) !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  next();
}

const slugSql = (col) =>
  `trim(both '-' from lower(regexp_replace(${col}, '[^a-zA-Z0-9]+', '-', 'g')))`;

// GET /models: every make/model pair (for the sitemap and a models index)
router.get('/models', async (req, res) => {
  try {
    const { rows } = await zingoPool.query(
      `SELECT
         ${slugSql('make')}  AS make_slug,
         ${slugSql('model')} AS model_slug,
         mode() WITHIN GROUP (ORDER BY make)  AS make,
         mode() WITHIN GROUP (ORDER BY model) AS model,
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'available')::int AS available,
         max(bumped_at) AS updated_at
       FROM ev_listings
       WHERE deleted_at IS NULL
         AND make IS NOT NULL AND make <> ''
         AND model IS NOT NULL AND model <> ''
       GROUP BY 1, 2
       ORDER BY available DESC, total DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /models failed', err);
    res.status(500).json({ error: 'Could not load models' });
  }
});

// GET /models/:make/:model: price range, stats and listings for one model
router.get('/models/:make/:model', async (req, res) => {
  const params = [req.params.make, req.params.model];
  const match = `deleted_at IS NULL AND ${slugSql('make')} = $1 AND ${slugSql('model')} = $2`;

  try {
    const [stats, listings] = await Promise.all([
      zingoPool.query(
        `SELECT
           mode() WITHIN GROUP (ORDER BY make)  AS make,
           mode() WITHIN GROUP (ORDER BY model) AS model,
           count(*)::int AS total,
           count(*) FILTER (WHERE status = 'available')::int AS available,
           min(COALESCE(price_min, price)::float8)
             FILTER (WHERE status = 'available' AND currency = 'USD'
                     AND COALESCE(price_min, price) > 0) AS min_price,
           max(COALESCE(price_max, price)::float8)
             FILTER (WHERE status = 'available' AND currency = 'USD'
                     AND COALESCE(price_max, price) > 0) AS max_price,
           min(year) FILTER (WHERE status = 'available') AS min_year,
           max(year) FILTER (WHERE status = 'available') AS max_year,
           max(range_km) FILTER (WHERE status = 'available') AS max_range_km
         FROM ev_listings
         WHERE ${match}`,
        params
      ),
      zingoPool.query(
        `SELECT
           id, slug, title, status, condition, currency, year,
           price::float8 AS price,
           masked_price,
           mileage_km, range_km,
           car->>'location' AS location,
           COALESCE(image_rows->0->'image_paths'->>0,
                    image_rows->1->'image_paths'->>0) AS cover_image
         FROM ev_listings
         WHERE ${match}
         ORDER BY (status = 'available') DESC, bumped_at DESC NULLS LAST
         LIMIT 24`,
        params
      ),
    ]);

    const s = stats.rows[0];
    if (!s || s.total === 0) return res.status(404).json({ error: 'Model not found' });
    res.json({ ...s, currency: 'USD', listings: listings.rows });
  } catch (err) {
    console.error('GET /models/:make/:model failed', err);
    res.status(500).json({ error: 'Could not load model' });
  }
});

// GET /listing-slugs: for the sitemap
router.get('/listing-slugs', async (req, res) => {
  try {
    const { rows } = await zingoPool.query(
      `SELECT slug, COALESCE(bumped_at, created_at) AS updated_at
         FROM ev_listings
        WHERE deleted_at IS NULL
        ORDER BY id DESC
        LIMIT 50000`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /listing-slugs failed', err);
    res.status(500).json({ error: 'Could not load slugs' });
  }
});

// GET /dealers: list for the dropdown
router.get('/dealers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await zingoPool.query(
      `SELECT id, name FROM ev_dealers ORDER BY name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /dealers failed', err);
    res.status(500).json({ error: 'Could not load dealers' });
  }
});

// PATCH /listings/:slug/dealer   body: { "dealer_id": 5 }  (null clears it)
router.patch('/listings/:slug/dealer', requireAuth, requireAdmin, async (req, res) => {
  const raw = req.body && req.body.dealer_id;
  const dealerId = raw === null || raw === undefined || raw === '' ? null : String(raw);

  try {
    // Confirm the dealer exists so we return a clean 400 instead of a FK error
    if (dealerId !== null) {
      const d = await zingoPool.query(`SELECT 1 FROM ev_dealers WHERE id = $1`, [dealerId]);
      if (d.rowCount === 0) return res.status(400).json({ error: 'Dealer not found' });
    }

    const { rows } = await zingoPool.query(
      `UPDATE ev_listings
          SET dealer_id = $1
        WHERE slug = $2 AND deleted_at IS NULL
        RETURNING id, slug, dealer_id`,
      [dealerId, req.params.slug]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('PATCH /listings/:slug/dealer failed', err);
    res.status(500).json({ error: 'Could not update dealer' });
  }
});

router.get('/listings', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 60);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = ['deleted_at IS NULL'];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  // Text search: every word must match title, make or model
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  for (const term of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
    params.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`); // escape LIKE wildcards
    const p = `$${params.length}`;
    where.push(`(title ILIKE ${p} OR make ILIKE ${p} OR model ILIKE ${p})`);
  }


   // Exact-match filters (whitelisted)
  if (LISTING_STATUSES.includes(req.query.status)) add('status = ?', req.query.status);
  if (['new', 'used'].includes(req.query.condition)) add('condition = ?', req.query.condition);

  // Brand: matches the make column, or the title if make is empty
  const make = typeof req.query.make === 'string' ? req.query.make.trim().slice(0, 40) : '';
  if (make) {
    params.push(make);
    const exact = `$${params.length}`;
    params.push(`${make.replace(/[\\%_]/g, '\\$&')}%`);
    const prefix = `$${params.length}`;
    where.push(`(lower(make) = lower(${exact}) OR (make IS NULL AND title ILIKE ${prefix}))`);
  }

  // Range filters
  if (num(req.query.min_price) !== null) add('price >= ?', num(req.query.min_price));
  if (num(req.query.max_price) !== null) add('price <= ?', num(req.query.max_price));
  if (num(req.query.min_year) !== null) add('year >= ?', num(req.query.min_year));
  if (num(req.query.min_range) !== null) add('range_km >= ?', num(req.query.min_range));

  const orderBy = SORTS[req.query.sort] || SORTS.newest;
  params.push(limit, offset);

  try {
   const { rows } = await zingoPool.query(
    `SELECT
      id, slug, title, status, condition, currency, year,
      price::float8       AS price,
      masked_price as masked_price,
      (SELECT d.name FROM ev_dealers d WHERE d.id = ev_listings.dealer_id) AS dealer_name,
      mileage_km,
      battery_kwh::float8 AS battery_kwh,
      range_km,
      car->>'range_standard' AS range_standard,
      car->>'location'       AS location,
      car->>'seller_type'    AS seller_type,
      COALESCE((car->>'negotiable')::boolean, false) AS negotiable,
      bumped_at,
      (bump_count > 0 AND bumped_at > now() - interval '24 hours') AS recently_bumped,
      COALESCE(image_rows->0->'image_paths'->>0, image_rows->1->'image_paths'->>0) AS cover_image,

      -- Only set when the latest change was a recent drop in the same currency
      CASE
        WHEN ph.previous_price IS NOT NULL
          AND ph.previous_currency = currency
          AND price < ph.previous_price
          AND ph.changed_at > now() - interval '30 days'
        THEN ph.previous_price::float8
      END AS previous_price
    FROM ev_listings
    LEFT JOIN LATERAL (
      SELECT
        (array_agg(p.price    ORDER BY p.recorded_at DESC, p.id DESC))[2] AS previous_price,
        (array_agg(p.currency ORDER BY p.recorded_at DESC, p.id DESC))[2] AS previous_currency,
        (array_agg(p.recorded_at ORDER BY p.recorded_at DESC, p.id DESC))[1] AS changed_at
      FROM (
        SELECT price, currency, recorded_at, id
          FROM ev_listing_prices
          WHERE listing_id = ev_listings.id
          ORDER BY recorded_at DESC, id DESC
          LIMIT 2
      ) p
    ) ph ON true
    WHERE ${where.join(' AND ')}
    ORDER BY (status = 'available') DESC, ${orderBy}
    LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
    res.json(rows);
  } catch (err) {
    console.error('GET /listings failed', err);
    res.status(500).json({ error: 'Could not load listings' });
  }
});
// Note: if `car` / `image_rows` are plain TEXT columns instead of json/jsonb,
// cast them first, e.g. car::jsonb->>'location'.

// GET /listings/:slug
// Full listing for the detail page. Leaves out internal columns
// (posted_by, telegram_chat_id) so they never reach the browser.
router.get('/listings/:slug', async (req, res) => {
  try {
    const { rows } = await zingoPool.query(
      `SELECT
         l.id, l.slug, l.title, l.status, l.condition, l.make, l.model, l.year, l.currency,
         l.price::float8       AS price,
         l.masked_price AS masked_price,
         l.mileage_km,
         l.battery_kwh::float8 AS battery_kwh,
         l.range_km, l.connector, l.car, l.features, l.image_rows, l.created_at,
         CASE
           WHEN d.id IS NULL THEN NULL
           ELSE json_build_object(
             'id',          d.id,
             'name',        d.name,
             'description', d.description,
             'phone',       d.phone,
             'telegram',    d.telegram,
             'social',      d.social,
             'location',    d.location,
             'map',         d.map,
             'logo_url',    d.logo_url
           )
         END AS dealer
       FROM ev_listings l
       LEFT JOIN ev_dealers d ON d.id = l.dealer_id
       WHERE l.slug = $1 AND l.deleted_at IS NULL
       LIMIT 1`,
      [req.params.slug]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /listings/:slug failed', err);
    res.status(500).json({ error: 'Could not load listing' });
  }
});

router.get('/listings/:slug/similar', async (req, res) => {
  try {
    const { rows } = await zingoPool.query(
      `WITH t AS (
         SELECT id, lower(make) AS make, lower(model) AS model, year, currency,
                price::float8 AS price, range_km, condition,
                car->>'body_type' AS body_type,
                car->>'engine'    AS engine
           FROM ev_listings
          WHERE slug = $1 AND deleted_at IS NULL
       )
       SELECT * FROM (
         SELECT
           l.id, l.slug, l.title, l.status, l.condition, l.currency, l.year,
           l.price::float8 AS price,
           l.masked_price,
           l.mileage_km,
           l.battery_kwh::float8 AS battery_kwh,
           l.range_km,
           l.car->>'location' AS location,
           l.bumped_at,
           COALESCE(l.image_rows->0->'image_paths'->>0,
                    l.image_rows->1->'image_paths'->>0) AS cover_image,
           (
             COALESCE((lower(l.make)  = t.make )::int, 0) * 30 +
             COALESCE((lower(l.model) = t.model)::int, 0) * 20 +
             COALESCE((l.car->>'body_type' = t.body_type)::int, 0) * 15 +
             COALESCE((l.car->>'engine'    = t.engine   )::int, 0) * 5 +
             COALESCE((l.condition = t.condition)::int, 0) * 5 +
             CASE WHEN t.price > 0 AND l.price > 0 AND l.currency = t.currency
                  THEN 20 * GREATEST(0, 1 - ABS(l.price::float8 - t.price) / t.price)
                  ELSE 0 END +
             COALESCE(10 * GREATEST(0, 1 - ABS(l.year - t.year) / 6.0), 0) +
             CASE WHEN t.range_km > 0 AND l.range_km > 0
                  THEN 5 * GREATEST(0, 1 - ABS(l.range_km - t.range_km)::float8 / t.range_km)
                  ELSE 0 END
           ) AS score
         FROM ev_listings l, t
         WHERE l.deleted_at IS NULL
           AND l.status = 'available'
           AND l.id <> t.id
           AND (
             lower(l.make) = t.make
             OR l.car->>'body_type' = t.body_type
             OR (t.price > 0 AND l.currency = t.currency
                 AND l.price BETWEEN t.price * 0.7 AND t.price * 1.3)
           )
       ) s
       ORDER BY score DESC, bumped_at DESC NULLS LAST
       LIMIT 10`,
      [req.params.slug]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /listings/:slug/similar failed', err);
    res.status(500).json({ error: 'Could not load similar cars' });
  }
});

// GET /me/listings?limit=24&offset=0
// Listings posted by the logged-in user. Same columns as GET /listings,
// so the same card works for both.
router.get('/me/listings', requireAuth, async (req, res) => {
  console.log("GET /me/listings");
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 60);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const userId = req.user.id; // <- adjust to however requireAuth exposes the user

  try {
    const { rows } = await zingoPool.query(
      `SELECT
         id,
         slug,
         title,
         status,
         condition,
         currency,
         year,
         price::float8       AS price,
         mileage_km,
         battery_kwh::float8 AS battery_kwh,
         range_km,
         car->>'location'                             AS location,
         COALESCE((car->>'negotiable')::boolean, false) AS negotiable,
         COALESCE(
           image_rows->0->'image_paths'->>0,
           image_rows->1->'image_paths'->>0
         )                                            AS cover_image,
         bumped_at,
         created_at,
         dealer_id
       FROM ev_listings
       WHERE posted_by = $1 AND deleted_at IS NULL
       ORDER BY bumped_at DESC NULLS LAST, created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /me/listings failed', err);
    res.status(500).json({ error: 'Could not load your listings' });
  }
});

// PATCH /listings/:slug/status   body: { "status": "sold" }
// Only the owner can change it. A listing that isn't yours looks the same
// as one that doesn't exist (404), so slugs can't be probed.
// Needs express.json() somewhere up the chain.
router.patch('/listings/:slug/status', requireAuth, async (req, res) => {
  const status = req.body && req.body.status;
  if (!LISTING_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Status must be one of: ${LISTING_STATUSES.join(', ')}`,
    });
  }

  try {
    const { rows } = await zingoPool.query(
      `UPDATE ev_listings
          SET status = $1
        WHERE slug = $2 AND posted_by = $3 AND deleted_at IS NULL
        RETURNING id, slug, status`,
      [status, req.params.slug, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    res.json({ data: rows[0] });
  } catch (err) {
    console.error('PATCH /listings/:slug/status failed', err);
    res.status(500).json({ error: 'Could not update status' });
  }
});

// DELETE /listings/:slug
// Soft delete: hides the listing instead of removing the row, so the app's
// DB role only needs UPDATE. A weekly cleanup job hard-deletes rows (and
// their S3 photos) once deleted_at is older than 7 days.
// Requires: ALTER TABLE ev_listings ADD COLUMN deleted_at timestamptz;
router.delete('/listings/:slug', requireAuth, async (req, res) => {
  try {
    const { rows } = await zingoPool.query(
      `UPDATE ev_listings
          SET deleted_at = now()
        WHERE slug = $1 AND posted_by = $2 AND deleted_at IS NULL
        RETURNING id`,
      [req.params.slug, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    res.json({ data: { id: rows[0].id } });
  } catch (err) {
    console.error('DELETE /listings/:slug failed', err);
    res.status(500).json({ error: 'Could not delete listing' });
  }
});

module.exports = router;