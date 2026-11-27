const express = require("express");
const zingoPool = require("./database/pgZingo");
const router = express.Router();


const SITE = process.env.SITE_URL || "https://zeloev.com";

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

const urlTag = (path, lastmod, changefreq, priority) =>
  `<url><loc>${xmlEscape(SITE + path)}</loc>` +
  (lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : "") +
  (changefreq ? `<changefreq>${changefreq}</changefreq>` : "") +
  (priority ? `<priority>${priority}</priority>` : "") +
  `</url>`;

let cache = { xml: null, at: 0 };
const TTL_MS = 60 * 60 * 1000; // 1 hour

const slugSql = (col) =>
  `trim(both '-' from regexp_replace(lower(${col}), '[^a-z0-9]+', '-', 'g'))`;

router.get("/sitemap.xml", async (req, res) => {
  try {
    if (!cache.xml || Date.now() - cache.at > TTL_MS) {
      const [models, listings] = await Promise.all([
        zingoPool.query(
          `SELECT ${slugSql("make")} AS make_slug, ${slugSql("model")} AS model_slug,
                  max(bumped_at) AS updated_at
             FROM ev_listings
            WHERE deleted_at IS NULL
              AND make IS NOT NULL AND make <> ''
              AND model IS NOT NULL AND model <> ''
            GROUP BY 1, 2`
        ),
        zingoPool.query(
          `SELECT slug, COALESCE(bumped_at, created_at) AS updated_at
             FROM ev_listings
            WHERE deleted_at IS NULL
            ORDER BY id DESC
            LIMIT 49000`
        ),
      ]);

      const urls = [
        urlTag("/", null, "daily", "1.0"),
        ...models.rows.map((m) =>
          urlTag(`/models/${m.make_slug}/${m.model_slug}`, m.updated_at, "daily", "0.9")
        ),
        ...listings.rows.map((l) => urlTag(`/cars/${l.slug}`, l.updated_at)),
      ];

      cache = {
        xml:
          `<?xml version="1.0" encoding="UTF-8"?>` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
        at: Date.now(),
      };
    }

    res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(cache.xml);
  } catch (err) {
    console.error("GET /sitemap.xml failed", err);
    res.status(500).send("Could not build sitemap");
  }
});

module.exports = router;