// functions/receive_occupancy.js
/*
  receiveOccupancy (HTTP POST): the endpoint edge_ai/metadata_sender.py and
  scripts/simulate.js post to.

    1. Verify the HMAC-SHA256 signature with the shared secret.
    2. Reject stale payloads (5-minute freshness window) and exact replays
       (the signature is used as the occupancy doc ID, so a second copy of
       the same payload fails create()).
    3. Normalise the edge schema into the backend schema:
         edge    { room_id, status: "occupied"|"vacant", confidence, timestamp }
         backend { roomId,  humanPresent: bool,          confidence, timestamp }
    4. Write occupancy/{signature} (triggers handleOccupancy) and update
       rooms/{roomId}.lastReading, which the sweep and dashboard read.
*/

const { onRequest } = require('firebase-functions/v2/https');
const { db, Timestamp } = require('./lib/firebase');
const { HttpError } = require('./lib/auth');
const { verifySignature } = require('./lib/hmac');
const { HMAC_SECRET, MAX_CLOCK_SKEW_SECONDS } = require('./lib/config');

const ALREADY_EXISTS = 6; // gRPC status code

/** ISO-8601 string, or UNIX seconds from older edge builds. */
function parseTimestamp(raw) {
  if (typeof raw === 'number') return new Date(raw * 1000);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Persist one reading. Also used by demoAction, which is authenticated by
 * Firebase Auth instead of HMAC.
 */
async function writeReading({ roomId, humanPresent, confidence, timestamp, source, docId }) {
  const roomRef = db.collection('rooms').doc(roomId);
  const occRef = docId ? db.collection('occupancy').doc(docId) : db.collection('occupancy').doc();
  const ts = Timestamp.fromDate(timestamp);
  const reading = { humanPresent, confidence, timestamp: ts, source };

  try {
    await db.runTransaction(async (tx) => {
      const room = await tx.get(roomRef);
      if (!room.exists) throw new HttpError(404, `Unknown room ${roomId}`);
      tx.create(occRef, { roomId, ...reading, receivedAt: Timestamp.now() });
      // Out-of-order delivery (the edge queue retries) must not overwrite
      // a newer reading.
      const last = room.get('lastReading');
      if (!last || last.timestamp.toMillis() <= ts.toMillis()) {
        tx.update(roomRef, { lastReading: reading });
      }
    });
  } catch (err) {
    if (err.code === ALREADY_EXISTS) throw new HttpError(409, 'Duplicate payload');
    throw err;
  }
}

/** Validates and stores a signed payload. Returns { status, body }. */
async function ingestReading(payload, secret, nowMs = Date.now()) {
  const { room_id: roomId, status, confidence, timestamp } = payload || {};

  if (!roomId || !['occupied', 'vacant'].includes(status) || timestamp === undefined) {
    return { status: 400, body: { error: 'Missing or invalid room_id, status or timestamp' } };
  }
  if (!verifySignature(payload, secret)) {
    console.warn(`Rejected unsigned/forged payload for room ${roomId}`);
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  const ts = parseTimestamp(timestamp);
  if (!ts) return { status: 400, body: { error: 'Unparseable timestamp' } };
  const skewSeconds = Math.abs(nowMs - ts.getTime()) / 1000;
  if (skewSeconds > MAX_CLOCK_SKEW_SECONDS) {
    console.warn(`Stale payload for ${roomId}, skew ${skewSeconds}s`);
    return { status: 400, body: { error: 'Timestamp outside accepted window' } };
  }

  try {
    await writeReading({
      roomId,
      humanPresent: status === 'occupied',
      confidence: typeof confidence === 'number' ? confidence : 0,
      timestamp: ts,
      source: 'edge_device',
      docId: payload.signature,
    });
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    console.error('Failed to write occupancy doc:', err);
    return { status: 500, body: { error: 'Internal server error' } };
  }
  return { status: 200, body: { success: true, roomId } };
}

const receiveOccupancy = onRequest({ secrets: [HMAC_SECRET] }, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'Method Not Allowed' });
  }
  const { status, body } = await ingestReading(req.body, HMAC_SECRET.value());
  return res.status(status).send(body);
});

module.exports = { receiveOccupancy, ingestReading, writeReading };
