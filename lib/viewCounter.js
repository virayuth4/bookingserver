js
// viewCounter.js
let pending = {}; // { "slug:2026-09-26T14": 12, "slug:2026-09-26T15": 3 }

function getHourBucket() {
  return new Date().toISOString().slice(0, 13); // "2026-09-26T14"
}

function trackView(slug) {
  const key = `${slug}:${getHourBucket()}`;
  pending[key] = (pending[key] || 0) + 1;
}

function drainPending() {
  const toFlush = pending;
  pending = {}; // reset immediately so views during the flush aren't lost
  return toFlush;
}

module.exports = { trackView, drainPending };