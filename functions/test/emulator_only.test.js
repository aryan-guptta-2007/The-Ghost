// schedulerTick must never exist or run in a real project. No emulator needed.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const INDEX = require.resolve('../index');
let saved;

beforeEach(() => {
  saved = process.env.FUNCTIONS_EMULATOR;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FUNCTIONS_EMULATOR;
  else process.env.FUNCTIONS_EMULATOR = saved;
  delete require.cache[INDEX];
});

/** Loads index.js the way `firebase deploy` or the emulator would. */
function loadFunctions(emulator) {
  if (emulator) process.env.FUNCTIONS_EMULATOR = 'true';
  else delete process.env.FUNCTIONS_EMULATOR;
  delete require.cache[INDEX];
  return require(INDEX);
}

/** Calls an onRequest handler with a minimal request/response pair. */
function call(handler) {
  return new Promise((resolve) => {
    const headers = {};
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: (k, v) => (headers[k.toLowerCase()] = v),
      getHeader: (k) => headers[k.toLowerCase()],
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        resolve({ status: this.statusCode, body });
        return this;
      },
      end() {
        resolve({ status: this.statusCode });
      },
    });
    handler({ method: 'POST', headers: {}, header: () => undefined, body: {} }, res);
  });
}

describe('schedulerTick is emulator-only', () => {
  test('is not exported for deploy, so it is never created in production', () => {
    const prod = loadFunctions(false);
    assert.equal(prod.schedulerTick, undefined);
    assert.ok(prod.sweepActiveBookings && prod.cancelUnconfirmedBookings, 'real schedules still deploy');
  });

  test('is exported inside the emulator, where npm run demo needs it', () => {
    assert.equal(typeof loadFunctions(true).schedulerTick, 'function');
  });

  test('refuses to run outside the emulator even if it were deployed', async () => {
    delete process.env.FUNCTIONS_EMULATOR;
    const { schedulerTick } = require('../demo_action');
    // Without the guard the handler starts the sweep and waits on Firestore,
    // so a slow answer is itself the failure.
    const tooSlow = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('schedulerTick ran the jobs instead of refusing')), 2000).unref();
    });
    assert.deepEqual(await Promise.race([call(schedulerTick), tooSlow]), {
      status: 404,
      body: { error: 'Not found' },
    });
  });

  test('every Hosting rewrite points at a function that deploys to production', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'firebase.json'), 'utf8'));
    const prod = loadFunctions(false);
    for (const rewrite of config.hosting.rewrites) {
      if (!rewrite.function) continue;
      const id = rewrite.function.functionId;
      assert.ok(prod[id], `${rewrite.source} rewrites to ${id}, which is not deployed`);
    }
  });
});
