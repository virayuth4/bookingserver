const express = require("express");
const axios = require("axios");
const router = express.Router();
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken");
const zingoPool = require("../../../database/pgZingo");
const { admin, auth } = require("../../../auth/firebase-admin");
const { normalizePhoneNumber, toFirebaseEmail } = require("../../../lib/normalizePhoneNumber");
const multer = require("multer");
const { uploadMediaFilesToS3, deleteFileFromS3 } = require("../../../database/s3");


router.get("/merchants", async (req, res) => {
    console.log("Fetching merchants...");
  try {
    const EXCLUDED_IDS = [8, 9];

        const { rows } = await zingoPool.query(
        "SELECT id, slug, name, category, image_rows FROM booking_pages WHERE id <> ALL($1::int[])",
        [EXCLUDED_IDS]
        );
    return res.json(rows);
  } catch (error) {
    console.error("Error fetching merchants:", error);
    return res.status(500).json({ error: "Failed to fetch merchants." });
  }
});

module.exports = router;