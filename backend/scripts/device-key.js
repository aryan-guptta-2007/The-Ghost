// Prints the signing key for one room's edge device. Put it in that device's
// .env as GHOST_HMAC_SECRET. A stolen device can then sign for its own room
// and no other.
//
//   GHOST_HMAC_SECRET=<master secret from Vercel> npm run device-key -- room_101
//
// Keys are derived from the master secret, so there is nothing to store, and
// rotating the master replaces every device's key at once. When every device
// has its own key, set GHOST_REQUIRE_DEVICE_KEYS=true in Vercel so the master
// secret stops working as a signing key.

const { deviceKey } = require('../lib/hmac');

const [roomId] = process.argv.slice(2);
const master = process.env.GHOST_HMAC_SECRET;

if (!roomId || !master) {
  console.error('Usage: GHOST_HMAC_SECRET=<master secret> node scripts/device-key.js <roomId>');
  process.exit(1);
}
console.log(deviceKey(master, roomId));
