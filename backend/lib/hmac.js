// backend/lib/hmac.js
// Signature helpers shared by POST /api/occupancy and the simulator.

const crypto = require('crypto');

/**
 * Recreate the canonical JSON the device signed: sorted keys, no whitespace,
 * signature field excluded. Must byte-for-byte match _canonical_json() in
 * edge_ai/metadata_sender.py. The edge side normalises whole floats (0.0 ->
 * 0) because Python prints "0.0" where JavaScript prints "0".
 */
function canonicalJson(payload) {
  // eslint-disable-next-line no-unused-vars
  const { signature, ...rest } = payload;
  const sorted = {};
  Object.keys(rest)
    .sort()
    .forEach((k) => {
      sorted[k] = rest[k];
    });
  return JSON.stringify(sorted);
}

function sign(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

function verifySignature(payload, secret) {
  const expected = Buffer.from(sign(payload, secret));
  const provided = Buffer.from(String(payload.signature || ''));
  // Constant-time compare. timingSafeEqual throws unless the byte lengths
  // match, and a non-ASCII signature has more bytes than characters.
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

/**
 * The signing key for one room's device, derived from the master secret. A
 * device holds only this, so a stolen device can sign for its own room and
 * no other. Deriving it means no key storage and no extra Firestore read.
 * Hand one out with `npm run device-key -- <roomId>`.
 */
function deviceKey(masterSecret, roomId) {
  return crypto.createHmac('sha256', masterSecret).update(`device:${roomId}`, 'utf8').digest('hex');
}

module.exports = { canonicalJson, sign, verifySignature, deviceKey };
