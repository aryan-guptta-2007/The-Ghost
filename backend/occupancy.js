// backend/occupancy.js
/*
  A reading from an edge device, from arrival to verdict, in one request.
  (There are no Firestore triggers on Vercel, so the judging that used to
  run in a handleOccupancy trigger now runs right after the write.)

    1. Verify the HMAC-SHA256 signature with the shared secret.
    2. Reject payloads outside a 5-minute freshness window, and any reading
       that is not newer than the room's last one. That second rule stops
       exact replays and stale out-of-order deliveries without storing a doc
       per reading, which keeps writes to one per heartbeat.
    3. Normalise the edge schema into the backend schema:
         edge    { room_id, status: "occupied"|"vacant", confidence, timestamp }
         backend { roomId,  humanPresent: bool,          confidence, timestamp }
    4. Update rooms/{roomId}.lastReading, which the sweep and dashboard read.
    5. Judge it:
         vacant   + booking past its grace period -> flagGhost (warn the owner)
         occupied + an open warning               -> clearByPresence

  Firestore cost per reading: 1 write, about 2-3 reads.
*/

const { db, Timestamp } = require('./lib/firebase');
const { HttpError } = require('./lib/auth');
const { verifySignature } = require('./lib/hmac');
const { MAX_CLOCK_SKEW_SECONDS } = require('./lib/config');
const {
  findActiveBooking,
  graceElapsed,
  flagGhost,
  clearByPresence,
} = require('./lib/enforcement');

/** ISO-8601 string, or UNIX seconds from older edge builds. */
function parseTimestamp(raw) {
  if (typeof raw === 'number') return new Date(raw * 1000);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Store a reading as the room's latest. Rejects (409) anything not newer
 * than what is already there. Also used by the demo endpoint, which is
 * authenticated by Firebase Auth instead of HMAC.
 */
async function writeReading({ roomId, humanPresent, confidence, timestamp, source }) {
  const roomRef = db.collection('rooms').doc(roomId);
  const ts = Timestamp.fromDate(timestamp);
  await db.runTransaction(async (tx) => {
    const room = await tx.get(roomRef);
    if (!room.exists) throw new HttpError(404, `Unknown room ${roomId}`);
    const last = room.get('lastReading');
    if (last && last.timestamp.toMillis() >= ts.toMillis()) {
      throw new HttpError(409, 'Reading is not newer than the last one (duplicate, replay or late delivery)');
    }
    tx.update(roomRef, { lastReading: { humanPresent, confidence, timestamp: ts, source } });
  });
}

/** Decide what a reading means for the room's current booking. */
async function evaluateReading({ roomId, humanPresent }, now = Timestamp.now()) {
  const bookingDoc = await findActiveBooking(roomId, now);
  if (!bookingDoc) return 'no_booking';

  // The edge device already debounces 7 of 10 frames, so its verdict is
  // used as-is. Confidence is informational.
  if (humanPresent) {
    return (await clearByPresence(bookingDoc.id, now)) ? 'cleared' : 'present';
  }
  if (!graceElapsed(bookingDoc.data(), now)) return 'in_grace';

  const created = await flagGhost(bookingDoc, 'Room reads vacant after grace period', 'reading', now);
  return created ? 'warned' : 'already_warned';
}

/** Validate, store and judge a signed payload. Throws HttpError on rejection. */
async function receiveReading(payload, secret, nowMs = Date.now()) {
  const { room_id: roomId, status, confidence, timestamp } = payload || {};

  if (!roomId || !['occupied', 'vacant'].includes(status) || timestamp === undefined) {
    throw new HttpError(400, 'Missing or invalid room_id, status or timestamp');
  }
  if (!verifySignature(payload, secret)) {
    console.warn(`Rejected unsigned/forged payload for room ${roomId}`);
    throw new HttpError(401, 'Invalid signature');
  }
  const ts = parseTimestamp(timestamp);
  if (!ts) throw new HttpError(400, 'Unparseable timestamp');
  const skewSeconds = Math.abs(nowMs - ts.getTime()) / 1000;
  if (skewSeconds > MAX_CLOCK_SKEW_SECONDS) {
    console.warn(`Stale payload for ${roomId}, skew ${skewSeconds}s`);
    throw new HttpError(400, 'Timestamp outside accepted window');
  }

  const humanPresent = status === 'occupied';
  await writeReading({
    roomId,
    humanPresent,
    confidence: typeof confidence === 'number' ? confidence : 0,
    timestamp: ts,
    source: 'edge_device',
  });
  const outcome = await evaluateReading({ roomId, humanPresent });
  return { success: true, roomId, outcome };
}

module.exports = { receiveReading, writeReading, evaluateReading };
