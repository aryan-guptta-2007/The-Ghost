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
  const expected = sign(payload, secret);
  const provided = String(payload.signature || '');
  // Constant-time compare; lengths must match or timingSafeEqual throws.
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

module.exports = { canonicalJson, sign, verifySignature };
