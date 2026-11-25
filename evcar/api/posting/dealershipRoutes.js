const express = require("express");
const router = express.Router();
const zingoPool = require("../../../database/pgZingo");
const { parseTelegramInput } = require("../../../lib/parsers");
const { requireAuth } = require("../telegram/session");
const multer = require("multer");
const { uploadMediaFilesToS3, deleteFileFromS3 } = require("../../../database/s3");


const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_LOGO_MIME = ["image/png", "image/jpeg", "image/webp"];

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_LOGO_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Logo must be a PNG, JPG or WEBP image."));
  },
});

const handleLogoUpload = (req, res, next) => {
  logoUpload.single("logo")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: `Logo must be under ${MAX_LOGO_BYTES / 1024 / 1024}MB.` });
    }
    return res.status(400).json({ error: err.message || "Invalid logo upload." });
  });
};

async function uploadLogo(file, userId) {
  const [url] = await uploadMediaFilesToS3([file], `dealer-${userId}`, "image", {
    pathPrefix: "eatdoko/ev-dealers/logo",
  });
  return url;
}

// Best-effort cleanup. Never throws.
async function deleteLogo(url) {
  if (!url) return;
  try {
    await deleteFileFromS3(url);
  } catch (err) {
    console.error("S3 logo delete failed:", url, err);
  }
}
// ---------------------------------------------------------------------------
// Validation helpers
// (parsePhoneInput and parseSocialInput are the same as in your listings file.
//  If you'd rather not duplicate them, move them to lib/parsers.js and import.)
// ---------------------------------------------------------------------------
const TEXT_LIMITS = {
  name: 80,
  description: 1000,
  location: 120,
};

function parsePhoneInput(phone) {
  const value = (phone || "").trim();
  if (!value) return { value: null };
  if (!/^\+?[0-9\s\-().]{6,20}$/.test(value)) {
    return { error: "Phone number is invalid." };
  }
  return { value };
}

const ALLOWED_USER_ID = 1;

function requireAllowedUser(req, res, next) {
  if (Number(req.user?.id) !== ALLOWED_USER_ID) {
    return res.status(403).json({ error: "You don't have access to this." });
  }
  next();
}


const SOCIAL_HOSTS = ["facebook.com", "fb.com", "fb.me", "instagram.com", "instagr.am"];

function parseSocialInput(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { value: null };
  if (value.length > 200) return { error: "Social link is too long." };

  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const u = new URL(candidate);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) throw new Error();
    return { value: u.href };
  } catch {
    return { error: "Enter a valid Facebook or Instagram link." };
  }
}

function parseMapInput(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { value: null };
  if (value.length > 500) return { error: "Map link is too long." };
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error();
    return { value: u.href };
  } catch {
    return { error: "Map link must be a valid http(s) URL." };
  }
}

const parseId = (raw) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Shared by POST and PUT. Returns { value } or { error }.
function parseDealerBody(body) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!input) return { error: "Dealer details are required." };

  const dealer = {};

  // Text
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const v = String(input[field] ?? "").trim();
    if (v.length > max) return { error: `${field} is too long (max ${max} characters).` };
    dealer[field] = v || null;
  }
  if (!dealer.name) return { error: "Dealership name is required." };

  // Contact
  const phone = parsePhoneInput(input.phone);
  if (phone.error) return { error: phone.error };
  dealer.phone = phone.value ?? null;

  const telegram = parseTelegramInput(input.telegram);
  if (telegram.error) return { error: telegram.error };
  dealer.telegram = telegram.value ?? null;

  if (!dealer.phone && !dealer.telegram) {
    return { error: "Add a phone number or Telegram link so buyers can contact you." };
  }

  const social = parseSocialInput(input.social);
  if (social.error) return { error: social.error };
  dealer.social = social.value;

  // Location
  const map = parseMapInput(input.map);
  if (map.error) return { error: map.error };
  dealer.map = map.value;

  return { value: dealer };
}

const COLUMNS = `"id", "name", "description", "phone", "telegram", "social", "location", "map", "logo_url"`;
router.get("/dealers/:id", requireAuth, requireAllowedUser, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid dealer id." });

    const { rows } = await zingoPool.query(
      `SELECT ${COLUMNS} FROM "ev_dealers" WHERE "id" = $1 AND "posted_by" = $2 LIMIT 1`,
      [id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Dealer profile not found." });

    res.set("Cache-Control", "no-store");
    return res.status(200).json({ data: rows[0] });
  } catch (error) {
    console.error("Error loading dealer profile:", error);
    return res.status(500).json({ error: "Failed to load dealer profile." });
  }
});
// ---------------------------------------------------------------------------
// POST /dealers — create the dealer profile (one per user)
// ---------------------------------------------------------------------------
router.post("/dealers", requireAuth, requireAllowedUser, handleLogoUpload, async (req, res) => {
  let uploadedLogo = null;
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized." });

    const parsed = parseDealerBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const d = parsed.value;

    if (req.file) uploadedLogo = await uploadLogo(req.file, userId);

    const { rows } = await zingoPool.query(
      `INSERT INTO "ev_dealers"
         ("posted_by", "name", "description", "phone", "telegram", "social", "location", "map", "logo_url")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
      [userId, d.name, d.description, d.phone, d.telegram, d.social, d.location, d.map, uploadedLogo]
    );

    return res.status(201).json({ message: "Dealer profile created.", data: rows[0] });
  } catch (error) {
    console.error("Error creating dealer profile:", error);
    await deleteLogo(uploadedLogo); // don't leave an orphaned upload behind
    if (error.code === "23505") {
      return res.status(409).json({ error: "You already have a dealer profile." });
    }
    return res.status(500).json({ error: "Failed to create dealer profile. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// PUT /dealers/:id — edit the signed-in user's dealer profile
// ---------------------------------------------------------------------------
router.put("/dealers/:id", requireAuth, requireAllowedUser, handleLogoUpload, async (req, res) => {
  let uploadedLogo = null;
  try {
    const userId = req.user.id;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid dealer id." });

    const parsed = parseDealerBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const d = parsed.value;

    const current = await zingoPool.query(
      `SELECT "logo_url" FROM "ev_dealers" WHERE "id" = $1 AND "posted_by" = $2 LIMIT 1`,
      [id, userId]
    );
    if (!current.rows[0]) return res.status(404).json({ error: "Dealer profile not found." });
    const oldLogo = current.rows[0].logo_url;

    let logoUrl = oldLogo;
    if (req.file) {
      uploadedLogo = await uploadLogo(req.file, userId);
      logoUrl = uploadedLogo;
    } else if (req.body.remove_logo === "true") {
      logoUrl = null;
    }

    const { rows } = await zingoPool.query(
      `UPDATE "ev_dealers"
          SET "name" = $1, "description" = $2, "phone" = $3, "telegram" = $4,
              "social" = $5, "location" = $6, "map" = $7, "logo_url" = $8, "updated_at" = now()
        WHERE "id" = $9 AND "posted_by" = $10
        RETURNING ${COLUMNS}`,
      [d.name, d.description, d.phone, d.telegram, d.social, d.location, d.map, logoUrl, id, userId]
    );
    if (!rows[0]) {
      await deleteLogo(uploadedLogo);
      return res.status(404).json({ error: "Dealer profile not found." });
    }

    if (oldLogo && oldLogo !== logoUrl) deleteLogo(oldLogo);

    return res.status(200).json({ message: "Dealer profile saved.", data: rows[0] });
  } catch (error) {
    console.error("Error saving dealer profile:", error);
    await deleteLogo(uploadedLogo);
    return res.status(500).json({ error: "Failed to save dealer profile. Please try again." });
  }
});
module.exports = router;