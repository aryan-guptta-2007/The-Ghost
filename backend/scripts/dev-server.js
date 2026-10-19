// Local stand-in for Vercel: serves backend/api/*.js on http://127.0.0.1:5100/api/<name>
// against the emulators, and runs the scheduled jobs itself every few seconds
// in place of cron-job.org.
//
// Run through `npm run dev` or `npm run demo`, which start the emulators first.

const fs = require('fs');
const http = require('http');
const path = require('path');
require('./env');

const PORT = 5100; // uncommon on purpose: 3000 is usually taken by other dev servers
const API_DIR = path.join(__dirname, '..', 'api');
const ROUTES = Object.fromEntries(
  fs
    .readdirSync(API_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => [`/api/${path.basename(f, '.js')}`, require(path.join(API_DIR, f))])
);

/** Gives Node's response the status()/json() helpers Vercel provides. */
function vercelish(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
    return res;
  };
  return res;
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function startDevServer({ tickSeconds = 10, quiet = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const route = ROUTES[new URL(req.url, 'http://x').pathname];
    vercelish(res);
    if (!route) return res.status(404).json({ error: 'Not found' });
    req.body = await readJson(req);
    return route(req, res);
  });
  server.on('error', (err) => {
    // Fail loudly: if another server owns the port, readings would go to it.
    console.error(`[dev] cannot listen on 127.0.0.1:${PORT}: ${err.code || err.message}`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1');

  // forceSweep: locally there is no reason to wait for every 5th minute.
  const { runScheduledJobs } = require('../scheduler');
  const timer = setInterval(() => {
    runScheduledJobs({ forceSweep: true }).catch((err) => console.error('[dev] scheduled jobs failed:', err));
  }, tickSeconds * 1000);

  if (!quiet) console.log(`API: http://127.0.0.1:${PORT}/api  (${Object.keys(ROUTES).join(', ')})`);
  return {
    close: () => {
      clearInterval(timer);
      server.close();
    },
  };
}

if (require.main === module) startDevServer();

module.exports = { startDevServer, PORT };
