// Pure logic: no emulator needed. Run alone with `npm run test:unit`.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, sign, verifySignature } = require('../lib/hmac');
const {
  policyFor,
  energySavedKwh,
  hmacSecret,
  cronSecret,
  GRACE_SECONDS,
  CONFIRM_WINDOW_SECONDS,
  STALE_SECONDS,
  SWEEP_EVERY_MINUTES,
} = require('../lib/config');
const { sweepDue } = require('../scheduler');
const { ghostReason } = require('../sweep_active_bookings');
const { Timestamp } = require('../lib/firebase');

describe('HMAC signing', () => {
  // The same vector is asserted in edge_ai/tests/test_signing.py. If either
  // side changes how it serialises, one of the two tests fails.
  const payload = {
    room_id: 'room_101',
    status: 'vacant',
    confidence: 0,
    timestamp: '2026-01-01T00:00:00+00:00',
  };
  const VECTOR = '527f9fcaff60db95667dd447ae33fd1b11c6c6fc05e8b95ef6dc6f6d85d19964';

  test('canonical JSON sorts keys and drops the signature', () => {
    assert.equal(
      canonicalJson({ ...payload, signature: 'x' }),
      '{"confidence":0,"room_id":"room_101","status":"vacant","timestamp":"2026-01-01T00:00:00+00:00"}'
    );
  });

  test('matches the cross-language vector', () => {
    assert.equal(sign(payload, 'test-secret'), VECTOR);
  });

  test('rejects a tampered payload', () => {
    const signed = { ...payload, signature: sign(payload, 'test-secret') };
    assert.equal(verifySignature(signed, 'test-secret'), true);
    assert.equal(verifySignature({ ...signed, status: 'occupied' }, 'test-secret'), false);
    assert.equal(verifySignature({ ...signed, signature: 'short' }, 'test-secret'), false);
  });
});

describe('policyFor', () => {
  test('defaults when the booking sets nothing', () => {
    assert.deepEqual(policyFor({}), {
      graceSeconds: GRACE_SECONDS,
      confirmWindowSeconds: CONFIRM_WINDOW_SECONDS,
    });
  });

  test('overrides can tighten but never loosen enforcement', () => {
    assert.deepEqual(policyFor({ graceSeconds: 30, confirmWindowSeconds: 60 }), {
      graceSeconds: 30,
      confirmWindowSeconds: 60,
    });
    assert.deepEqual(policyFor({ graceSeconds: 99999, confirmWindowSeconds: 99999 }), {
      graceSeconds: GRACE_SECONDS,
      confirmWindowSeconds: CONFIRM_WINDOW_SECONDS,
    });
    assert.equal(policyFor({ confirmWindowSeconds: 1 }).confirmWindowSeconds, 30);
  });
});

describe('energySavedKwh', () => {
  test('is power x remaining time', () => {
    assert.equal(energySavedKwh(4.3, 30 * 60_000), 2.15);
  });

  test('falls back to the default room draw and never goes negative', () => {
    assert.equal(energySavedKwh(undefined, 60 * 60_000), 4.3);
    assert.equal(energySavedKwh(4.3, -5000), 0);
  });
});

describe('ghostReason', () => {
  const now = Timestamp.fromMillis(1_800_000_000_000);
  const reading = (secondsAgo, humanPresent) => ({
    lastReading: { humanPresent, timestamp: Timestamp.fromMillis(now.toMillis() - secondsAgo * 1000) },
  });

  test('missing, stale and vacant rooms are ghosts', () => {
    assert.match(ghostReason(null, now), /No occupancy data/);
    assert.match(ghostReason({}, now), /No occupancy data/);
    assert.match(ghostReason(reading(STALE_SECONDS + 60, true), now), new RegExp(`silent for ${STALE_SECONDS + 60}s`));
    assert.equal(ghostReason(reading(30, false), now), 'Room reads vacant');
  });

  test('a fresh occupied reading is not', () => {
    assert.equal(ghostReason(reading(30, true), now), null);
  });
});

describe('free-tier defaults', () => {
  test('a device is silent after 12 minutes and the sweep runs every 5th minute', () => {
    assert.equal(STALE_SECONDS, 12 * 60);
    assert.equal(SWEEP_EVERY_MINUTES, 5);
    const at = (minute) => Timestamp.fromMillis(minute * 60_000 + 7_000);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((m) => sweepDue(at(m))), [true, false, false, false, false, true]);
  });
});

describe('secrets', () => {
  const saved = { ...process.env };
  const restore = () => {
    for (const k of ['FIRESTORE_EMULATOR_HOST', 'GHOST_HMAC_SECRET', 'CRON_SECRET']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };

  test('a real deployment without secrets fails closed instead of using dev values', () => {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.GHOST_HMAC_SECRET;
    delete process.env.CRON_SECRET;
    try {
      assert.throws(hmacSecret, /GHOST_HMAC_SECRET is not set/);
      assert.throws(cronSecret, /CRON_SECRET is not set/);
    } finally {
      restore();
    }
  });

  test('the emulator gets fixed dev secrets, and env vars always win', () => {
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    delete process.env.GHOST_HMAC_SECRET;
    try {
      assert.equal(hmacSecret(), 'local-dev-secret');
      process.env.GHOST_HMAC_SECRET = 'from-env';
      assert.equal(hmacSecret(), 'from-env');
    } finally {
      restore();
    }
  });
});
