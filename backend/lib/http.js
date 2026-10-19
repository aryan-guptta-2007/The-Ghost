// backend/lib/http.js
// Shared wrapper for the endpoints in backend/api/. Each file there is one
// Vercel serverless function; scripts/dev-server.js serves the same files
// locally. Both give handlers a Node request with a parsed JSON body and a
// response with status()/json().

const { HttpError } = require('./auth');
const { usingEmulator } = require('./firebase');

const LOCAL_ORIGINS = ['http://127.0.0.1:5000', 'http://localhost:5000'];

/**
 * Browser origins allowed to call the API: the Firebase Hosting site, set
 * in ALLOWED_ORIGINS as a comma-separated list. Edge devices and cron jobs
 * send no Origin header and are not affected by CORS.
 */
function allowedOrigins() {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return usingEmulator() ? [...configured, ...LOCAL_ORIGINS] : configured;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '3600');
  }
  res.setHeader('Vary', 'Origin');
}

/**
 * Wraps a handler: CORS, preflight, method check, and HttpError -> status.
 * The handler returns { status?, body } or throws.
 */
function endpoint(name, handler, { methods = ['POST'] } = {}) {
  return async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!methods.includes(req.method)) {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    try {
      const { status = 200, body } = await handler(req);
      return res.status(status).json(body);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(`${name}:`, err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

module.exports = { endpoint, allowedOrigins };
