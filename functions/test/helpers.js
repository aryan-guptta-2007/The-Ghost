// Shared fixtures for the emulator tests. Run via `npm test`, which starts
// the Firestore and Auth emulators with `firebase emulators:exec`.

const { db, Timestamp, getAuth } = require('../lib/firebase');
const { sign } = require('../lib/hmac');
const assert = require('node:assert/strict');

const PROJECT = process.env.GCLOUD_PROJECT;
const SECRET = 'test-secret';
const MIN = 60_000;

function requireEmulators() {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('Integration tests need the emulators. Run `npm test`, not `jest` directly.');
  }
}

async function resetEmulators() {
  await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' }
  );
  await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`, {
    method: 'DELETE',
  });
}

async function addRoom(roomId, data = {}) {
  await db.collection('rooms').doc(roomId).set({ name: roomId, powerKw: 4.3, ...data });
}

/** A booking that started `startedMinAgo` minutes ago and runs `lengthMin`. */
async function addBooking({ roomId, userId = 'owner', startedMinAgo = 11, lengthMin = 60, ...extra }) {
  const start = Date.now() - startedMinAgo * MIN;
  const ref = await db.collection('bookings').add({
    roomId,
    userId,
    status: 'scheduled',
    startTime: Timestamp.fromMillis(start),
    endTime: Timestamp.fromMillis(start + lengthMin * MIN),
    ...extra,
  });
  return ref.get();
}

function signedPayload(roomId, status, { confidence = status === 'occupied' ? 0.78 : 0, at = new Date() } = {}) {
  const payload = { room_id: roomId, status, confidence, timestamp: at.toISOString() };
  return { ...payload, signature: sign(payload, SECRET) };
}

/** Creates a user in the Auth emulator and returns a real ID token for it. */
async function idTokenFor(uid, claims) {
  const email = `${uid}@test.dev`;
  await getAuth().createUser({ uid, email, password: 'password123' });
  if (claims) await getAuth().setCustomUserClaims(uid, claims);
  const res = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
    }
  );
  return (await res.json()).idToken;
}

const doc = async (path) => (await db.doc(path).get()).data();
const later = (minutes) => Timestamp.fromMillis(Date.now() + minutes * MIN);

/** Asserts every key in `expected` equals the same key in `actual`. */
function matches(actual, expected) {
  assert.ok(actual, 'expected a value, got nothing');
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `field "${key}"`);
  }
}

module.exports = {
  SECRET,
  requireEmulators,
  resetEmulators,
  addRoom,
  addBooking,
  signedPayload,
  idTokenFor,
  doc,
  later,
  matches,
};

