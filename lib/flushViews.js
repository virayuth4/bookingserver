// flushViews.js
const zingoPool = require("../database/pgZingo");
const { drainPending } = require("./viewCounter");

function startViewFlusher() {
  setInterval(async () => {
    const counts = drainPending();
    const entries = Object.entries(counts);
    if (entries.length === 0) return;

    for (const [key, count] of entries) {
      const [slug, hourBucket] = key.split(":");
      try {
        await zingoPool.query(
          `INSERT INTO "page_views_hourly" ("slug", "hour_bucket", "count")
           VALUES ($1, $2, $3)
           ON CONFLICT ("slug", "hour_bucket") DO UPDATE
           SET "count" = "page_views_hourly"."count" + $3`,
          [slug, hourBucket, count]
        );
      } catch (error) {
        console.error(`Failed to flush views for ${key}:`, error);
      }
    }
  }, 30 * 60 * 1000);
}

module.exports = { startViewFlusher };