/**
 * Normalizes a Cambodian phone number so it's consistently formatted
 * starting with "0". Handles numbers stored with the "855" country
 * code, with or without a leading "+", and strips any other
 * non-digit characters (spaces, dashes, etc.) first.
 *
 * e.g. "85512345678"  -> "012345678"
 *      "+855 12 345 678" -> "012345678"
 *      "012345678"    -> "012345678"
 *      "12345678"     -> "012345678"
 */
function normalizePhoneNumber(phone) {
  if (!phone) return phone;

  let cleaned = String(phone).replace(/\D/g, '');

  if (cleaned.startsWith('855')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (!cleaned.startsWith('0')) {
    cleaned = '0' + cleaned;
  }

  return cleaned;
}

/**
 * Builds the Firebase Auth lookup email for a phone number, from
 * either raw or already-normalized input. Used consistently by every
 * route that creates or looks up a phone-based Firebase account, so
 * registration and password reset always agree on the same email.
 *
 * e.g. "012345678" -> "12345678@phone.com"
 */
function toFirebaseEmail(phone) {
  const normalized = normalizePhoneNumber(phone);
  return `855${normalized.slice(1)}@phone.com`; // strip the leading 0, prepend country code
}

module.exports = { normalizePhoneNumber, toFirebaseEmail };