const zingoPool = require("../database/pgZingo");

async function getPageForMerchant(pageId, merchantId) {
  const result = await zingoPool.query(
    `SELECT * FROM "booking_pages" WHERE "id" = $1 AND "merchant_id" = $2`,
    [pageId, merchantId]
  );
  return result.rows[0] || null;
}


module.exports = { getPageForMerchant};