// functions/receive_occupancy.js
/*
  Firebase Cloud Function: receiveOccupancy  (HTTP POST)
  ------------------------------------------------------
  This is the endpoint edge_ai/metadata_sender.py posts to. It was
  referenced by the edge device but never implemented — this closes the
  edge -> backend gap.

  Responsibilities:
    1. Verify the HMAC-SHA256 signature using the shared secret.
    2. Reject replayed / stale payloads (timestamp freshness window).
    3. Normalise the edge device's snake_case schema into the camelCase
       schema that handleOccupancy expects.
    4. Write one document into `occupancy/`, which triggers handleOccupancy.

  SCHEMA TRANSLATION (this mismatch was a silent breakage):
      edge sends   -> { room_id, status: "occupied"|"vacant", confidence, timestamp }
      backend uses -> { roomId,  humanPresent: bool,          confidence, timestamp }

  SECRET:
      firebase functions:config:set ghost.hmac_secret="<same value as GHOST_HMAC_SECRET>"
*/

const functions = require('firebase-functions');
const crypto = require('crypto');
const { admin, db } = require('./lib/firebase');

// Payloads older than this are rejected as possible replays.
const MAX_CLOCK_SKEW_SECONDS = 300; // 5 minutes

function getSecret() {
  const secret =
    process.env.GHOST_HMAC_SECRET ||
    (functions.config().ghost && functions.config().ghost.hmac_secret);
  if (!secret) {
    throw new Error('HMAC secret not configured (ghost.hmac_secret)');
  }
  return secret;
}

/**
 * Recreate the canonical JSON the device signed: sorted keys, no whitespace,
 * signature field excluded. Must byte-for-byte match _canonical_json() in
 * edge_ai/metadata_sender.py.
 */
function canonicalJson(payload) {
  const { signature, ...rest } = payload;
  const sorted = {};
  Object.keys(rest)
    .sort()
    .forEach((k) => {
      sorted[k] = rest[k];
    });
  return JSON.stringify(sorted);
}

function verifySignature(payload) {
  const expected = crypto
    .createHmac('sha256', getSecret())
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');

  const provided = String(payload.signature || '');
  // Constant-time compare; lengths must match or timingSafeEqual throws.
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * Accept either an ISO-8601 string or a UNIX float (the device currently
 * sends a float even though its docstring promises ISO — accept both).
 */
function parseTimestamp(raw) {
  if (typeof raw === 'number') return new Date(raw * 1000);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

exports.receiveOccupancy = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'Method Not Allowed' });
  }

  const payload = req.body || {};
  const { room_id: roomId, status, confidence, timestamp } = payload;

  if (!roomId || !status || timestamp === undefined) {
    return res
      .status(400)
      .send({ error: 'Missing room_id, status or timestamp' });
  }

  // 1. Authenticate the device.
  let signatureOk = false;
  try {
    signatureOk = verifySignature(payload);
  } catch (err) {
    console.error('Signature verification error:', err.message);
    return res.status(500).send({ error: 'Server misconfigured' });
  }
  if (!signatureOk) {
    console.warn(`Rejected unsigned/forged payload for room ${roomId}`);
    return res.status(401).send({ error: 'Invalid signature' });
  }

  // 2. Reject stale payloads (replay protection).
  const ts = parseTimestamp(timestamp);
  if (!ts) {
    return res.status(400).send({ error: 'Unparseable timestamp' });
  }
  const skewSeconds = Math.abs((Date.now() - ts.getTime()) / 1000);
  if (skewSeconds > MAX_CLOCK_SKEW_SECONDS) {
    console.warn(`Stale payload for ${roomId}, skew ${skewSeconds}s`);
    return res.status(400).send({ error: 'Timestamp outside accepted window' });
  }

  // 3. Normalise into the internal schema and persist.
  try {
    await db.collection('occupancy').add({
      roomId,
      humanPresent: status === 'occupied',
      confidence: typeof confidence === 'number' ? confidence : 0,
      timestamp: admin.firestore.Timestamp.fromDate(ts),
      receivedAt: admin.firestore.Timestamp.now(),
      source: 'edge_device',
    });
  } catch (err) {
    console.error('Failed to write occupancy doc:', err);
    return res.status(500).send({ error: 'Internal server error' });
  }

  return res.status(200).send({ success: true, roomId });
});
