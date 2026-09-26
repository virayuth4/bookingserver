const express = require("express");
const axios = require("axios");
const router = express.Router();
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken");
const zingoPool = require("../../../database/pgZingo");
const { admin, auth } = require("../../../auth/firebase-admin");
const { normalizePhoneNumber, toFirebaseEmail } = require("../../../lib/normalizePhoneNumber");
const multer = require("multer");
const { uploadMediaFilesToS3, deleteFileFromS3 } = require("../../../database/s3");


router.get("/booking-settings/check-slug", authenticateFirebaseToken, async (req, res) => {
  try {
    const rawSlug = req.query.slug || "";
    const excludeId = req.query.excludeId ? Number(req.query.excludeId) : null;

    const formattedSlug = slugify(rawSlug);

    if (!formattedSlug || formattedSlug.length < 3) {
      return res.status(200).json({
        available: false,
        slug: formattedSlug,
        message: "Slug must be at least 3 characters long.",
      });
    }

    // Query whether any other page is already using this slug
    const query = excludeId
      ? `SELECT 1 FROM "booking_pages" WHERE "slug" = $1 AND "id" <> $2 LIMIT 1`
      : `SELECT 1 FROM "booking_pages" WHERE "slug" = $1 LIMIT 1`;
    const params = excludeId ? [formattedSlug, excludeId] : [formattedSlug];

    const result = await zingoPool.query(query, params);
    const isAvailable = result.rowCount === 0;

    return res.status(200).json({
      available: isAvailable,
      slug: formattedSlug,
      message: isAvailable ? "Link is available!" : "This link is already taken.",
    });
  } catch (error) {
    console.error("Error checking slug availability:", error);
    return res.status(500).json({ error: "Failed to verify slug." });
  }
});

module.exports = router;