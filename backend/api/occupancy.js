// POST /api/occupancy — signed readings from edge devices (HMAC, no login).
const { endpoint } = require('../lib/http');
const { hmacSecret } = require('../lib/config');
const { receiveReading } = require('../occupancy');

module.exports = endpoint('occupancy', async (req) => ({
  body: await receiveReading(req.body, hmacSecret()),
}));
