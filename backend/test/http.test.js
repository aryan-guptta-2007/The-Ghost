// The Vercel endpoints themselves (backend/api/*.js), called the way Vercel
// calls them. Runs against the emulators.

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const CRON_SECRET = 'test-cron-secret';
const SITE = 'https://ghost-buster-demo.web.app';
let saved;

before(() => {
  h.requireEmulators();
  saved = { cron: process.env.CRON_SECRET, hmac: process.env.GHOST_HMAC_SECRET, origins: process.env.ALLOWED_ORIGINS };
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.GHOST_HMAC_SECRET = h.SECRET;
  process.env.ALLOWED_ORIGINS = SITE;
});
after(() => {
  for (const [key, name] of [['cron', 'CRON_SECRET'], ['hmac', 'GHOST_HMAC_SECRET'], ['origins', 'ALLOWED_ORIGINS']]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
});
beforeEach(h.resetEmulators);

/** Invoke a handler with a Vercel-style request/response pair. */
function call(handler, { method = 'POST', headers = {}, body = {} } = {}) {
  return new Promise((resolve) => {
    const out = { headers: {} };
    const res = {
      setHeader: (k, v) => (out.headers[k.toLowerCase()] = v),
      status(code) {
        out.status = code;
        return this;
      },
      json(data) {
        resolve({ ...out, body: data });
        return this;
      },
      end() {
        resolve(out);
        return this;
      },
    };
    handler({ method, headers, body }, res);
  });
}

const cron = require('../api/cron');
const occupancy = require('../api/occupancy');
const confirm = require('../api/confirm');

describe('POST /api/cron', () => {
  test('refuses callers without the secret', async () => {
    assert.equal((await call(cron)).status, 401);
    assert.equal((await call(cron, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await call(cron, { headers: { authorization: `Bearer ${CRON_SECRET}x` } })).status, 401);
  });

  test('with the secret, runs reclaim (and the sweep when due)', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101' });
    await require('../occupancy').receiveReading(h.signedPayload('room_101', 'vacant'), h.SECRET);

    // Accepts GET too, which is cron-job.org's default method.
    const res = await call(cron, { method: 'GET', headers: { authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.reclaim, { expired: 0, reclaimed: 0 });
    assert.ok('sweep' in res.body);
    h.matches(await h.doc(`confirmations/${booking.id}`), { status: 'pending' });
  });
});

describe('POST /api/occupancy', () => {
  test('stores and judges a signed reading in one request', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101' });
    const res = await call(occupancy, { body: h.signedPayload('room_101', 'vacant') });
    assert.deepEqual(res, { status: 200, headers: { vary: 'Origin' }, body: { success: true, roomId: 'room_101', outcome: 'warned' } });
    h.matches(await h.doc(`enforcement/${booking.id}`), { status: 'warned', source: 'reading' });
  });

  test('maps rejections to HTTP status codes', async () => {
    await h.addRoom('room_101');
    const forged = { ...h.signedPayload('room_101', 'vacant'), status: 'occupied' };
    assert.equal((await call(occupancy, { body: forged })).status, 401);
    assert.equal((await call(occupancy, { body: {} })).status, 400);
    assert.equal((await call(occupancy, { method: 'GET' })).status, 405);
  });
});

describe('CORS and auth on browser endpoints', () => {
  test('the Hosting site may call the API; other origins get no CORS grant', async () => {
    const ok = await call(confirm, { method: 'OPTIONS', headers: { origin: SITE } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], SITE);
    assert.match(ok.headers['access-control-allow-headers'], /Authorization/);

    const evil = await call(confirm, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(evil.headers['access-control-allow-origin'], undefined);
  });

  test('confirm needs a Firebase ID token', async () => {
    const res = await call(confirm, { headers: { origin: SITE }, body: { confirmationId: 'x' } });
    assert.equal(res.status, 401);
  });
});
