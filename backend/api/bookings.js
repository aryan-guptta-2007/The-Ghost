// POST /api/bookings — book a room (Firebase ID token, overlap-checked).
const { endpoint } = require('../lib/http');
const { verifyBearer } = require('../lib/auth');
const { bookAs } = require('../create_booking');

module.exports = endpoint('bookings', async (req) => {
  const token = await verifyBearer(req);
  return { status: 201, body: await bookAs(token, req.body || {}) };
});
