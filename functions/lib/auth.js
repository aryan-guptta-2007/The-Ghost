// functions/lib/auth.js
// Verifies the Firebase ID token sent as "Authorization: Bearer <token>".

const { getAuth } = require('./firebase');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Returns the decoded token, or throws HttpError(401). */
async function verifyBearer(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw new HttpError(401, 'Missing bearer token');
  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch (err) {
    throw new HttpError(401, 'Invalid or expired token');
  }
}

function isStaff(token) {
  return token.admin === true || token.demo === true;
}

/** Shared error responder for the HTTP functions. */
function sendError(res, err, label) {
  if (err instanceof HttpError) {
    return res.status(err.status).send({ error: err.message });
  }
  console.error(`${label}:`, err);
  return res.status(500).send({ error: 'Internal server error' });
}

module.exports = { HttpError, verifyBearer, isStaff, sendError };
