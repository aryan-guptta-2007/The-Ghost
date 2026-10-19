// POST /api/demo — camera-free demo controls (staff only, demo rooms only).
const { endpoint } = require('../lib/http');
const { verifyBearer } = require('../lib/auth');
const { demoLogic } = require('../demo_action');

module.exports = endpoint('demo', async (req) => {
  const token = await verifyBearer(req);
  return { body: await demoLogic(token, req.body || {}) };
});
