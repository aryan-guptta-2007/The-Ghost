// backend/lib/auth.js
// Request authentication: Firebase ID tokens for people, a shared secret
// for the cron caller.

const crypto = require('crypto');
const { getAuth } = require('./firebase');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bearer(req) {
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

/** Verifies "Authorization: Bearer <Firebase ID token>". Returns the decoded token. */
async function verifyBearer(req) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Missing bearer token');
  try {
    return await getAuth().verifyIdToken(token);
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
}

/** Verifies "Authorization: Bearer <CRON_SECRET>" in constant time. */
function verifySharedSecret(req, expected) {
  const provided = Buffer.from(bearer(req) || '');
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
    throw new HttpError(401, 'Invalid cron secret');
  }
}

function isStaff(token) {
  return token.admin === true || token.demo === true;
}

module.exports = { HttpError, verifyBearer, verifySharedSecret, isStaff };
