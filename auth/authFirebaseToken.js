const admin = require('firebase-admin');
const zingoPool = require('../database/pgZingo');

const authenticateFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const userIdentifier = req.headers['x-user-identifier']; // Get the phone number from custom header

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Check if user authenticated with email or phone
    const userEmail = decodedToken.email;
    const userPhone = decodedToken.phone_number;
    
    // console.log("Auth details:", { userEmail, userPhone, userIdentifier });
    
    let query;
    let params;
    
    if (userEmail) {
      // Email authentication
      query = 'SELECT id FROM booking_users WHERE email = $1';
      params = [userEmail];
    } else if (userPhone || userIdentifier) {
      // Phone authentication - use either the phone from token or the custom header
      const phoneNumber = userPhone ? userPhone.replace('+', '') : userIdentifier;
      query = 'SELECT id FROM booking_users WHERE email = $1';
      params = [phoneNumber];
    } else {
      return res.status(400).json({ error: 'No valid identifier found' });
    }

    try {
      const result = await zingoPool.query(query, params);

      if (result.rows.length === 0) {
        console.error('User does not exist in database');
        return res.status(404).json({ error: 'User not found in database' });
      }

      req.user = {
        id: result.rows[0].id,
        email: userEmail,
        phone: userPhone || userIdentifier,
        ...decodedToken
      };

      next();
      
    } catch (error) {
      console.error('Database Error:', error);
      return res.status(500).json({ error: 'Database Error' });
    }
  } catch (error) {
    console.error('Error verifying Firebase ID token:', error);
    return res.status(403).json({ error: 'Unauthorized: Invalid token' });
  }
};



module.exports = authenticateFirebaseToken;