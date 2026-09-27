const escapeHtml = (str) =>
  String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
 
// `pg` returns date/timestamp columns as JS Date objects. Dropping one
// straight into a template literal calls .toString(), which includes the
// full "GMT+0700 (Indochina Time)" suffix — these format explicitly instead.
function formatBookingDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Phnom_Penh",
  });
}
 
// start_time is a Postgres `time without time zone` column, so pg returns
// it as a plain "HH:MM:SS" string — parse it directly rather than via Date.
function formatBookingTime(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value);
 
  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
 
  return `${hours}:${minutes} ${suffix}`;
}


function formatRequestedAt(date = new Date()) {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Phnom_Penh',
  });
}
module.exports = { formatBookingDate, formatBookingTime, formatRequestedAt, escapeHtml};