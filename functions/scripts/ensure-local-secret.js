// Creates functions/.secret.local for the emulator if it does not exist.
// The Functions emulator reads secrets from this file instead of Secret
// Manager. It is gitignored.

const crypto = require('crypto');
const fs = require('fs');
const { SECRET_FILE } = require('./env');

if (!fs.existsSync(SECRET_FILE)) {
  fs.writeFileSync(SECRET_FILE, `GHOST_HMAC_SECRET=${crypto.randomBytes(32).toString('hex')}\n`);
  console.log(`Created ${SECRET_FILE} with a random emulator secret.`);
}
