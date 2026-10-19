// POST /api/confirm — the booking owner says "I'm here" (Firebase ID token).
const { endpoint } = require('../lib/http');
const { verifyBearer } = require('../lib/auth');
const { confirmLogic } = require('../confirm_attendance');

module.exports = endpoint('confirm', async (req) => {
  const token = await verifyBearer(req);
  return { body: await confirmLogic(token.uid, (req.body || {}).confirmationId) };
});
