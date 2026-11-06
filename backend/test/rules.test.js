// firestore.rules, exercised as a signed-in client. The Admin SDK used
// everywhere else bypasses the rules, so nothing else in the suite covers
// them. Calls the emulator's REST API with real ID tokens from the Auth
// emulator, which is what the browser SDK does underneath.

const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db, Timestamp } = require('../lib/firebase');

const DOCS = () =>
  `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`;

const string = (value) => ({ stringValue: value });

/** PATCH a document as `token`, touching only `fields`. Returns the HTTP status. */
async function write(path, token, fields) {
  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const res = await fetch(`${DOCS()}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return res.status;
}

async function read(path, token) {
  const res = await fetch(`${DOCS()}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.status;
}

before(h.requireEmulators);
beforeEach(h.resetEmulators);

describe('bookings', () => {
  const booking = (status) =>
    db.doc('bookings/b1').set({
      roomId: 'room_101',
      userId: 'alice',
      status,
      startTime: Timestamp.now(),
      endTime: Timestamp.fromMillis(Date.now() + 3_600_000),
    });

  test('an owner can cancel a live booking and nothing else about it', async () => {
    const alice = await h.idTokenFor('alice');
    await booking('scheduled');
    assert.equal(await write('bookings/b1', alice, { roomId: string('room_999') }), 403);
    assert.equal(await write('bookings/b1', alice, { status: string('canceled'), roomId: string('room_999') }), 403);
    assert.equal(await write('bookings/b1', alice, { status: string('canceled') }), 200);
  });

  test('a finished booking cannot be rewritten as cancelled', async () => {
    const alice = await h.idTokenFor('alice');
    await booking('completed');
    assert.equal(await write('bookings/b1', alice, { status: string('canceled') }), 403);
  });

  test("nobody else can cancel someone's booking, and staff can read but not write", async () => {
    const mallory = await h.idTokenFor('mallory');
    const viewer = await h.idTokenFor('viewer', { demo: true });
    await booking('scheduled');
    assert.equal(await write('bookings/b1', mallory, { status: string('canceled') }), 403);
    assert.equal(await read('bookings/b1', mallory), 403);
    assert.equal(await read('bookings/b1', viewer), 200);
    assert.equal(await write('bookings/b1', viewer, { status: string('canceled') }), 403);
  });
});

describe('users', () => {
  test('a user can register an FCM token on their own document and nothing else', async () => {
    const alice = await h.idTokenFor('alice');
    assert.equal(await write('users/alice', alice, { admin: string('true') }), 403);
    assert.equal(await write('users/alice', alice, { fcmToken: string('t'), admin: string('true') }), 403);
    assert.equal(await write('users/alice', alice, { fcmToken: string('t1') }), 200); // create
    assert.equal(await write('users/alice', alice, { fcmToken: string('t2') }), 200); // update
    assert.equal(await read('users/alice', alice), 200);
  });

  test("push tokens are private: the public demo login cannot read other people's", async () => {
    const viewer = await h.idTokenFor('viewer', { demo: true });
    const mallory = await h.idTokenFor('mallory');
    await db.doc('users/alice').set({ fcmToken: 'secret-token' });
    assert.equal(await read('users/alice', viewer), 403);
    assert.equal(await read('users/alice', mallory), 403);
    assert.equal(await write('users/alice', mallory, { fcmToken: string('hijack') }), 403);
  });
});

describe('sensor and enforcement data', () => {
  test('no client can forge a reading or touch the logs', async () => {
    const admin = await h.idTokenFor('boss', { admin: true });
    await h.addRoom('room_101');
    assert.equal(await read('rooms/room_101', admin), 200);
    assert.equal(await write('rooms/room_101', admin, { name: string('x') }), 403);
    assert.equal(await write('confirmations/b1', admin, { status: string('confirmed') }), 403);
    assert.equal(await write('decision_logs/d1', admin, { decision: string('x') }), 403);
    assert.equal(await write('stats/global', admin, { roomsReclaimed: string('9') }), 403);
  });
});
