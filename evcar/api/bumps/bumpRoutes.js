
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const multer = require("multer");
const { uploadMediaFilesToS3, deleteFileFromS3 } = require("../../../database/s3");
const { parseTelegramInput } = require("../../../lib/parsers");
const zingoPool = require("../../../database/pgZingo");
const { requireAuth } = require("../telegram/session");


const BUMP_COST_POINTS = 10;          // server-side only, never from the client
const BUMP_COOLDOWN_MINUTES = 60;     // short, just to stop accidental double clicks

router.post('/listings/bump/:slug', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

  const slug = String(req.params.slug || '').trim();
  if (!slug || slug.length > 200) {
    return res.status(400).json({ error: 'Invalid listing slug.' });
  }

  const clientKey = String(req.get('Idempotency-Key') || '').slice(0, 100);
  if (!clientKey) return res.status(400).json({ error: 'Missing Idempotency-Key header.' });
  const idempotencyKey = `bump:${userId}:${clientKey}`;

  const client = await zingoPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Bump the listing (ownership + cooldown + not sold, checked atomically)
    const upd = await client.query(
      `UPDATE "ev_listings"
          SET "bumped_at" = now(), "bump_count" = "bump_count" + 1
        WHERE "slug" = $1 AND "posted_by" = $2
          AND "status" <> 'sold'
          AND "bumped_at" <= now() - make_interval(mins => $3)
        RETURNING "id", "slug", "bumped_at"`,
      [slug, userId, BUMP_COOLDOWN_MINUTES]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return explainBumpFailure(res, slug, userId);
    }
    const listingId = upd.rows[0].id; // still needed for the ledger

    // 2. Deduct points (unchanged)
    const debit = await client.query(
      `UPDATE "ev_users" SET "points" = "points" - $2
        WHERE "id" = $1 AND "points" >= $2
        RETURNING "points"`,
      [userId, BUMP_COST_POINTS]
    );
    if (debit.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(402).json({ error: 'Not enough points.', required: BUMP_COST_POINTS });
    }
    const balanceAfter = debit.rows[0].points;

    // 3. Ledger row (uses the id resolved from the slug)
    const led = await client.query(
      `INSERT INTO "ev_point_ledger"
         ("user_id", "kind", "amount", "balance_after", "listing_id", "idempotency_key")
       VALUES ($1, 'bump', $2, $3, $4, $5)
       ON CONFLICT ("idempotency_key") DO NOTHING
       RETURNING "id"`,
      [userId, -BUMP_COST_POINTS, balanceAfter, listingId, idempotencyKey]
    );
    if (led.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ message: 'Already processed.', alreadyApplied: true });
    }

    await client.query('COMMIT');
    return res.status(200).json({
      message: 'Listing bumped.',
      data: { ...upd.rows[0], points: balanceAfter },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error bumping EV listing:', error);
    return res.status(500).json({ error: 'Failed to bump listing.' });
  } finally {
    client.release();
  }
});

async function explainBumpFailure(res, slug, userId) {
  const { rows } = await zingoPool.query(
    `SELECT "posted_by", "status",
            "bumped_at" + make_interval(mins => $2) AS next_bump_at
       FROM "ev_listings" WHERE "slug" = $1`,
    [slug, BUMP_COOLDOWN_MINUTES]
  );
  const listing = rows[0];
  // Same 404 for "missing" and "not yours" so slugs can't be probed
  if (!listing || String(listing.posted_by) !== String(userId)) {
    return res.status(404).json({ error: 'Listing not found.' });
  }
  if (listing.status === 'sold') {
    return res.status(400).json({ error: 'Sold listings cannot be bumped.' });
  }
  return res.status(429).json({
    error: 'This listing was bumped recently.',
    next_bump_at: listing.next_bump_at,
  });
}
module.exports = router;