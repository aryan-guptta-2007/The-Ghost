// POST /api/cron — sweep + reclaim. Called every minute by cron-job.org with
// "Authorization: Bearer <CRON_SECRET>". Anyone else gets 401.
const { endpoint } = require('../lib/http');
const { verifySharedSecret } = require('../lib/auth');
const { cronSecret } = require('../lib/config');
const { runScheduledJobs } = require('../scheduler');

module.exports = endpoint(
  'cron',
  async (req) => {
    verifySharedSecret(req, cronSecret());
    return { body: await runScheduledJobs() };
  },
  { methods: ['POST', 'GET'] }
);
