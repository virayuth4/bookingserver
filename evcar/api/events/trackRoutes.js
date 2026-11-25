const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const zingoPool = require("../../../database/pgZingo");
const { getOptionalUserId } = require("../telegram/session");

const EVENT_TYPES = new Set(["listing_click", "contact_click"]);
const CHANNELS = new Set(["facebook", "telegram", "instagram", "phone"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);
const posInt = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function readCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}


// sendBeacon with a string body arrives as text/plain, so parse as text on this route
router.post(
  "/track",
  express.text({ type: () => true, limit: "4kb" }),
  async (req, res) => {
    res.status(204).end();

    try {
      let raw = req.body;
      if (typeof raw === "string") raw = JSON.parse(raw);
      if (!raw || typeof raw !== "object") return;

      // Accept both flat payloads and { props: {...} }
      const p = { ...raw, ...(raw.props && typeof raw.props === "object" ? raw.props : {}) };

      const type = p.type ?? p.event;
      if (!EVENT_TYPES.has(type)) return;

      const channel = CHANNELS.has(p.channel) ? p.channel : null;
      if (type === "contact_click" && !channel) return;

      const eventId = UUID_RE.test(p.event_id) ? p.event_id : crypto.randomUUID();
      const visitorCandidate = p.visitor_id ?? readCookie(req, "vid");
      const visitorId = UUID_RE.test(visitorCandidate) ? visitorCandidate : null;

      const position = Number.isInteger(p.position) && p.position >= 0 && p.position < 32767
        ? p.position
        : null;

      // Keep only unknown extras in props
      const known = new Set([
        "type", "event", "event_id", "visitor_id", "listingId", "dealerId", "slug",
        "channel", "position", "surface", "path", "referrer", "ts", "props",
      ]);
      const extras = Object.fromEntries(Object.entries(p).filter(([k]) => !known.has(k)));
      const userId = await getOptionalUserId(req);

      await zingoPool
        .query(
          `insert into ev_events
             (event_id, type, visitor_id, user_id, listing_id, dealer_id, listing_slug,
              channel, position, surface, path, referrer, props)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
           on conflict (event_id) do nothing`,
          [
            eventId,
            type,
            visitorId,
            userId,
            posInt(p.listingId),
            posInt(p.dealerId),
            str(p.slug, 200),
            channel,
            position,
            str(p.surface, 50),
            str(p.path, 500),
            str(p.referrer, 500),
            JSON.stringify(extras),
          ]
        )
        .catch((err) => console.error("[track] insert failed:", err.message));
    } catch (err) {
      console.error("[track] bad payload:", err.message);
    }
  }
);

module.exports = router;