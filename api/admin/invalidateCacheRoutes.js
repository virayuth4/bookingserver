const express = require("express");
const { pageCache } = require("../../lib/pageCache");

const router = express.Router();


router.post('/cache/booking-pages/invalidate', async (req, res) => {
  const adminKey = req.get('x-admin-key');
  console.log("adminKey", adminKey, process.env.ADMIN_CACHE_KEY);
  if (!process.env.ADMIN_CACHE_KEY || adminKey !== process.env.ADMIN_CACHE_KEY) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const { slug } = req.body || {};

  if (slug) {
    const deleted = pageCache.delete(slug);
    console.log(`[booking-page cache] MANUAL INVALIDATE slug=${slug}`);
    return res.json({ cleared: deleted ? 1 : 0, slug });
  }

  const count = pageCache.size;
  pageCache.clear();
  console.log(`[booking-page cache] MANUAL CLEAR ALL count=${count}`);
  return res.json({ cleared: count });
});

module.exports = router;