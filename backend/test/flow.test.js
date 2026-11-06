// End-to-end enforcement flows against the Firestore + Auth emulators.
// Each test drives the same logic the deployed triggers and schedules run,
// with `now` passed in so the timing windows can be crossed instantly.

const { describe, test, before, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db, Timestamp } = require('../lib/firebase');
const { receiveReading, evaluateReading, writeReading } = require('../occupancy');
const { deviceKey, sign } = require('../lib/hmac');
const { sweepActiveBookingsLogic } = require('../sweep_active_bookings');
const { cancelUnconfirmedBookingsLogic } = require('../cancel_unconfirmed_booking');
const { confirmLogic } = require('../confirm_attendance');
const { createBookingLogic, bookAs } = require('../create_booking');
const { demoLogic } = require('../demo_action');
const { verifyBearer } = require('../lib/auth');

const { matches } = h;
const NOTHING_RECLAIMED = { expired: 0, reclaimed: 0 };

before(h.requireEmulators);
beforeEach(h.resetEmulators);

/** Send a signed reading through the same path as POST /api/occupancy; returns the verdict. */
async function reading(roomId, status, opts) {
  const res = await receiveReading(h.signedPayload(roomId, status, opts), h.SECRET);
  assert.equal(res.success, true);
  return res.outcome;
}

describe('ghost path', () => {
  test('vacant room is warned, then reclaimed with energy recorded', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101', startedMinAgo: 11, lengthMin: 60 });

    assert.equal(await reading('room_101', 'vacant'), 'warned');
    matches(await h.doc(`enforcement/${booking.id}`), { status: 'warned', userId: 'owner' });
    matches(await h.doc(`confirmations/${booking.id}`), { status: 'pending', notified: false });

    // Nothing to reclaim while the window is open.
    assert.deepEqual(await cancelUnconfirmedBookingsLogic(), NOTHING_RECLAIMED);
    assert.deepEqual(await cancelUnconfirmedBookingsLogic(h.later(6)), { expired: 1, reclaimed: 1 });

    matches(await h.doc(`bookings/${booking.id}`), { status: 'canceled', cancelReason: 'ghost_reclaimed' });
    matches(await h.doc(`enforcement/${booking.id}`), { status: 'reclaimed' });

    // 49 min were left when warned; reclaimed 6 min later => 43 min x 4.3 kW.
    const audit = await h.doc(`audit_logs/ghost_${booking.id}`);
    matches(audit, { action: 'ghost_reclaimed', remainingMinutes: 43 });
    assert.ok(Math.abs(audit.energySavedKwh - 4.3 * (43 / 60)) < 0.05, `got ${audit.energySavedKwh}`);

    matches(await h.doc('stats/global'), { ghostsFlagged: 1, roomsReclaimed: 1, minutesReclaimed: 43 });
  });

  test('a booking still in its grace period is left alone', async () => {
    await h.addRoom('room_101');
    await h.addBooking({ roomId: 'room_101', startedMinAgo: 2 });
    assert.equal(await reading('room_101', 'vacant'), 'in_grace');
  });

  test('repeat readings and sweeps warn a booking only once', async () => {
    await h.addRoom('room_101');
    await h.addBooking({ roomId: 'room_101' });
    assert.equal(await reading('room_101', 'vacant'), 'warned');
    assert.equal(await reading('room_101', 'vacant', { at: new Date(Date.now() + 1000) }), 'already_warned');
    assert.equal((await sweepActiveBookingsLogic()).flagged, 0);
    assert.equal((await h.doc('stats/global')).ghostsFlagged, 1);
  });
});

describe('confirm path', () => {
  test('owner confirms with a real ID token and the room is kept', async () => {
    await h.addRoom('room_101');
    const token = await h.idTokenFor('alice');
    const booking = await h.addBooking({ roomId: 'room_101', userId: 'alice' });
    await reading('room_101', 'vacant');

    const decoded = await verifyBearer({ headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(await confirmLogic(decoded.uid, booking.id), { success: true, confirmationId: booking.id });

    matches(await h.doc(`enforcement/${booking.id}`), { status: 'confirmed' });
    assert.deepEqual(await cancelUnconfirmedBookingsLogic(h.later(6)), NOTHING_RECLAIMED);
    matches(await h.doc(`bookings/${booking.id}`), { status: 'scheduled' });
  });

  test('requests without a valid token are rejected', async () => {
    await assert.rejects(verifyBearer({ headers: {} }), { status: 401 });
    await assert.rejects(verifyBearer({ headers: { authorization: 'Bearer forged' } }), { status: 401 });
  });

  test('another user cannot confirm, and an expired window cannot be confirmed', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101', userId: 'alice' });
    await reading('room_101', 'vacant');

    await assert.rejects(confirmLogic('mallory', booking.id), { status: 403 });
    await assert.rejects(confirmLogic('alice', booking.id, h.later(6)), { status: 410 });
    await assert.rejects(confirmLogic('alice', 'no-such-id'), { status: 404 });
  });

  test('a person walking in clears the warning without anyone confirming', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101' });
    await reading('room_101', 'vacant');
    assert.equal(await reading('room_101', 'occupied', { at: new Date(Date.now() + 1000) }), 'cleared');
    matches(await h.doc(`confirmations/${booking.id}`), { status: 'cleared' });
    assert.deepEqual(await cancelUnconfirmedBookingsLogic(h.later(6)), NOTHING_RECLAIMED);
  });
});

describe('re-checking a booking after a warning is answered', () => {
  const vacantAt = (minutes) => evaluateReading({ roomId: 'room_101', humanPresent: false }, h.later(minutes));

  test('a confirmed booking that stays empty is warned again after the grace period', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101', userId: 'alice' });
    await reading('room_101', 'vacant');
    await confirmLogic('alice', booking.id);

    assert.equal(await vacantAt(0), 'already_warned');
    assert.equal(await vacantAt(9), 'already_warned');
    assert.equal(await vacantAt(11), 'warned');

    matches(await h.doc(`enforcement/${booking.id}`), { status: 'warned' });
    matches(await h.doc(`confirmations/${booking.id}`), { status: 'pending' });
    assert.equal((await h.doc('stats/global')).ghostsFlagged, 2);

    // The second warning has its own window, and an unanswered one reclaims.
    assert.deepEqual(await cancelUnconfirmedBookingsLogic(h.later(12)), NOTHING_RECLAIMED);
    assert.deepEqual(await cancelUnconfirmedBookingsLogic(h.later(17)), { expired: 1, reclaimed: 1 });
    matches(await h.doc(`bookings/${booking.id}`), { status: 'canceled', cancelReason: 'ghost_reclaimed' });
  });

  test('a cleared booking is re-checked by the sweep too', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101' });
    await reading('room_101', 'vacant');
    await reading('room_101', 'occupied', { at: new Date(Date.now() + 1000) });

    assert.equal((await sweepActiveBookingsLogic(h.later(5))).flagged, 0);
    assert.equal((await sweepActiveBookingsLogic(h.later(13))).flagged, 1); // device now silent
    matches(await h.doc(`enforcement/${booking.id}`), { status: 'warned', source: 'sweep' });
  });

  test('an open or finished warning is never re-issued', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101' });
    await reading('room_101', 'vacant');
    assert.equal(await vacantAt(4), 'already_warned'); // still pending
    await cancelUnconfirmedBookingsLogic(h.later(6));
    assert.equal(await vacantAt(20), 'no_booking');
    matches(await h.doc(`enforcement/${booking.id}`), { status: 'reclaimed' });
    assert.equal((await h.doc('stats/global')).ghostsFlagged, 1);
  });
});

describe('warnings on bookings that are gone', () => {
  test('a booking cancelled while warned cannot be confirmed', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101', userId: 'alice' });
    await reading('room_101', 'vacant');
    await db.doc(`bookings/${booking.id}`).update({ status: 'canceled' });

    await assert.rejects(confirmLogic('alice', booking.id), { status: 409 });
    matches(await h.doc(`enforcement/${booking.id}`), { status: 'warned' });
    assert.equal((await h.doc('stats/global')).warningsConfirmed, undefined);
  });

  test('reclaiming a booking for a deleted room does not recreate the room', async () => {
    const booking = await h.addBooking({ roomId: 'deleted_room' });
    assert.equal((await sweepActiveBookingsLogic()).flagged, 1);
    assert.equal((await cancelUnconfirmedBookingsLogic(h.later(6))).reclaimed, 1);
    matches(await h.doc(`bookings/${booking.id}`), { status: 'canceled' });
    assert.equal(await h.doc('rooms/deleted_room'), undefined);
  });
});

describe('malformed ids', () => {
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  test('ids that are not valid document ids get 400, not a 500', async () => {
    const viewer = { uid: 'viewer', demo: true };
    await assert.rejects(confirmLogic('alice', 'a/b'), { status: 400 });
    await assert.rejects(createBookingLogic('alice', { roomId: 'a/b', startTime: inAnHour(), durationMinutes: 60 }), { status: 400 });
    await assert.rejects(demoLogic(viewer, { roomId: 'a/b', action: 'book' }), { status: 400 });
    await assert.rejects(demoLogic(viewer, { roomId: { x: 1 }, action: 'book' }), { status: 400 });
    await assert.rejects(receiveReading(h.signedPayload(101, 'vacant'), h.SECRET), { status: 400 });
    await assert.rejects(receiveReading(h.signedPayload('a/b', 'vacant'), h.SECRET), { status: 400 });
  });
});

describe('per-room device keys', () => {
  beforeEach(async () => {
    await h.addRoom('room_101');
    await h.addRoom('room_102');
  });
  const receive = (payload) => receiveReading(payload, h.SECRET);
  const keyFor = (roomId) => deviceKey(h.SECRET, roomId);

  test("a room's key signs for that room and no other", async () => {
    assert.equal((await receive(h.signedPayload('room_101', 'vacant', { key: keyFor('room_101') }))).success, true);
    await assert.rejects(receive(h.signedPayload('room_102', 'vacant', { key: keyFor('room_101') })), { status: 401 });
  });

  test('devices on the shared secret keep working until enforcement is switched on', async () => {
    assert.equal((await receive(h.signedPayload('room_101', 'vacant'))).success, true);

    process.env.GHOST_REQUIRE_DEVICE_KEYS = 'true';
    try {
      await assert.rejects(receive(h.signedPayload('room_102', 'vacant')), { status: 401 });
      assert.equal((await receive(h.signedPayload('room_102', 'vacant', { key: keyFor('room_102') }))).success, true);
    } finally {
      delete process.env.GHOST_REQUIRE_DEVICE_KEYS;
    }
  });
});

describe('ingest security', () => {
  beforeEach(() => h.addRoom('room_101'));
  const receive = (payload) => receiveReading(payload, h.SECRET);

  test('an exact replay is rejected even inside the freshness window', async () => {
    const payload = h.signedPayload('room_101', 'occupied');
    assert.equal((await receive(payload)).success, true);
    await assert.rejects(receive(payload), { status: 409 });
  });

  test('forged, stale and unknown-room payloads are rejected', async () => {
    const forged = { ...h.signedPayload('room_101', 'vacant'), status: 'occupied' };
    await assert.rejects(receive(forged), { status: 401 });

    const stale = h.signedPayload('room_101', 'occupied', { at: new Date(Date.now() - 10 * 60_000) });
    await assert.rejects(receive(stale), { status: 400 });

    await assert.rejects(receive(h.signedPayload('room_999', 'vacant')), { status: 404 });
  });

  test('a late-arriving older reading is refused and does not overwrite a newer one', async () => {
    await receive(h.signedPayload('room_101', 'occupied'));
    const late = h.signedPayload('room_101', 'vacant', { at: new Date(Date.now() - 60_000) });
    await assert.rejects(receive(late), { status: 409 });
    assert.equal((await h.doc('rooms/room_101')).lastReading.humanPresent, true);
  });

  test('a reading costs one write: nothing is stored besides the room', async () => {
    await receive(h.signedPayload('room_101', 'vacant'));
    const collections = (await db.listCollections()).map((c) => c.id);
    assert.deepEqual(collections, ['rooms']);
  });
});

describe('device offline (sweep)', () => {
  test('silent, never-reporting and vacant rooms are warned; occupied ones are not', async () => {
    const fresh = Timestamp.now();
    const old = Timestamp.fromMillis(Date.now() - 15 * 60_000); // past the 12-minute limit
    await h.addRoom('silent', { lastReading: { humanPresent: true, timestamp: old } });
    await h.addRoom('never');
    await h.addRoom('vacant', { lastReading: { humanPresent: false, timestamp: fresh } });
    await h.addRoom('busy', { lastReading: { humanPresent: true, timestamp: fresh } });
    for (const roomId of ['silent', 'never', 'vacant', 'busy']) await h.addBooking({ roomId });
    await h.addBooking({ roomId: 'busy', startedMinAgo: 120, lengthMin: 60 }); // already over

    assert.deepEqual(await sweepActiveBookingsLogic(), { checked: 4, flagged: 3, inGrace: 0, completed: 1 });

    const warned = await db.collection('enforcement').get();
    const reasons = Object.fromEntries(warned.docs.map((d) => [d.get('roomId'), d.get('reason')]));
    assert.match(reasons.silent, /Device silent/);
    assert.match(reasons.never, /No occupancy data/);
    assert.equal(reasons.vacant, 'Room reads vacant');
    assert.equal(reasons.busy, undefined);
  });
});

describe('booking API', () => {
  const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();

  test('creates a booking and refuses an overlapping one', async () => {
    await h.addRoom('room_101');
    const first = await createBookingLogic('alice', { roomId: 'room_101', startTime: inMinutes(60), durationMinutes: 60 });
    matches(await h.doc(`bookings/${first.bookingId}`), { userId: 'alice', status: 'scheduled' });

    await assert.rejects(
      createBookingLogic('bob', { roomId: 'room_101', startTime: inMinutes(90), durationMinutes: 60 }),
      { status: 409 }
    );
    const after = await createBookingLogic('bob', { roomId: 'room_101', startTime: inMinutes(120), durationMinutes: 30 });
    assert.equal(after.success, true);
  });

  test('validates input', async () => {
    await h.addRoom('room_101');
    const book = (body) => createBookingLogic('a', { roomId: 'room_101', startTime: inMinutes(1), durationMinutes: 60, ...body });
    await assert.rejects(book({ roomId: 'nope' }), { status: 404 });
    await assert.rejects(book({ durationMinutes: 5 }), { status: 400 });
    await assert.rejects(book({ startTime: 'garbage' }), { status: 400 });
    await assert.rejects(book({ startTime: inMinutes(-60) }), { status: 400 });
  });
});

describe('demo controls', () => {
  test('only staff, only demo rooms, and the demo booking uses short timers', async () => {
    await h.addRoom('demo_room', { demo: true });
    await h.addRoom('real_room');
    const viewer = { uid: 'viewer', demo: true };

    await assert.rejects(demoLogic({ uid: 'u' }, { roomId: 'demo_room', action: 'book' }), { status: 403 });
    await assert.rejects(demoLogic(viewer, { roomId: 'real_room', action: 'book' }), { status: 403 });

    const first = await demoLogic(viewer, { roomId: 'demo_room', action: 'book' });
    matches(await h.doc(`bookings/${first.bookingId}`), { userId: 'viewer', graceSeconds: 30, confirmWindowSeconds: 60 });

    // Booking again ends the previous demo booking instead of clashing with it.
    const second = await demoLogic(viewer, { roomId: 'demo_room', action: 'book' });
    matches(await h.doc(`bookings/${first.bookingId}`), { status: 'completed' });

    await demoLogic(viewer, { roomId: 'demo_room', action: 'vacant' });
    matches((await h.doc('rooms/demo_room')).lastReading, { humanPresent: false, source: 'demo' });

    // Past the 30s grace the sweep warns it; 60s later it is reclaimed.
    const t = (s) => Timestamp.fromMillis(Date.now() + s * 1000);
    assert.equal((await sweepActiveBookingsLogic(t(31))).flagged, 1);
    assert.equal((await cancelUnconfirmedBookingsLogic(t(92))).reclaimed, 1);
    matches(await h.doc(`bookings/${second.bookingId}`), { status: 'canceled' });
  });
});

describe('never cancelling a booking someone is using', () => {
  test('a person seen after the warning survives a lost verdict', async () => {
    // The reading was stored but judging it failed (timeout, quota). The retry
    // gets 409, which the edge counts as delivered, so nothing clears the warning.
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101' });
    await reading('room_101', 'vacant');
    await writeReading({ roomId: 'room_101', humanPresent: true, confidence: 0.78, timestamp: new Date(Date.now() + 60_000), source: 'edge_device' });

    assert.deepEqual(await cancelUnconfirmedBookingsLogic(h.later(6)), { expired: 1, reclaimed: 0 });
    matches(await h.doc(`bookings/${booking.id}`), { status: 'scheduled' });
    matches(await h.doc(`enforcement/${booking.id}`), { status: 'cleared' });
    matches(await h.doc(`confirmations/${booking.id}`), { status: 'cleared' });
    matches(await h.doc('stats/global'), { warningsCleared: 1 });
  });

  test('an "occupied" reading from before the warning does not save a silent room', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101' });
    await reading('room_101', 'occupied', { at: new Date(Date.now() - 4 * 60_000) });
    const swept = await sweepActiveBookingsLogic(h.later(9));
    assert.equal(swept.flagged, 1);

    assert.deepEqual(await cancelUnconfirmedBookingsLogic(h.later(15)), { expired: 1, reclaimed: 1 });
    matches(await h.doc(`bookings/${booking.id}`), { status: 'canceled' });
  });
});

describe('one failure does not take the rest down with it', () => {
  test('a booking the sweep cannot warn does not stop it warning the others', async () => {
    await h.addRoom('room_101');
    await h.addRoom('room_102');
    await h.addBooking({ roomId: 'room_101' });
    await h.addBooking({ roomId: 'room_102' });

    const failOnce = mock.method(db, 'runTransaction', async () => { throw new Error('contention'); }, { times: 1 });
    try {
      assert.equal((await sweepActiveBookingsLogic()).flagged, 1);
    } finally {
      failOnce.mock.restore();
    }
  });

  test('a decision log that cannot be written does not fail the decision', async () => {
    await h.addRoom('room_101');
    const booking = await h.addBooking({ roomId: 'room_101', userId: 'alice' });
    await reading('room_101', 'vacant');

    const realCollection = db.collection.bind(db);
    const brokenLog = mock.method(db, 'collection', (name) =>
      name === 'decision_logs' ? { add: async () => { throw new Error('quota exceeded'); } } : realCollection(name)
    );
    try {
      assert.deepEqual(await confirmLogic('alice', booking.id), { success: true, confirmationId: booking.id });
    } finally {
      brokenLog.mock.restore();
    }
  });
});

describe('the public demo account', () => {
  const demoUser = { uid: 'viewer', demo: true };
  const slot = { startTime: new Date(Date.now() + 60 * 60_000).toISOString(), durationMinutes: 60 };

  test('cannot book a real room, only a demo one', async () => {
    await h.addRoom('real_room');
    await h.addRoom('demo_room', { demo: true });

    await assert.rejects(bookAs(demoUser, { roomId: 'real_room', ...slot }), { status: 403 });
    assert.equal((await db.collection('bookings').get()).size, 0);
    assert.equal((await bookAs(demoUser, { roomId: 'demo_room', ...slot })).success, true);
  });

  test('members and admins book real rooms as before', async () => {
    await h.addRoom('real_room');
    assert.equal((await bookAs({ uid: 'member' }, { roomId: 'real_room', ...slot })).success, true);
    await h.addRoom('other_room');
    assert.equal((await bookAs({ uid: 'boss', admin: true, demo: true }, { roomId: 'other_room', ...slot })).success, true);
  });
});

describe('malformed signed payloads', () => {
  test('a numeric timestamp too large for a date is a 400, not a 500', async () => {
    await h.addRoom('room_101');
    const payload = { room_id: 'room_101', status: 'vacant', confidence: 0, timestamp: 1e20 };
    await assert.rejects(receiveReading({ ...payload, signature: sign(payload, h.SECRET) }, h.SECRET), { status: 400 });
  });
});
