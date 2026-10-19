// POST /api/bookings — book a room (Firebase ID token, overlap-checked).
const { endpoint } = require('../lib/http');
const { verifyBearer } = require('../lib/auth');
const { createBookingLogic } = require('../create_booking');

module.exports = endpoint('bookings', async (req) => {
  const token = await verifyBearer(req);
  return { status: 201, body: await createBookingLogic(token.uid, req.body || {}) };
});
