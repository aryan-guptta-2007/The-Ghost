// Grants a dashboard role to an existing Firebase Auth user.
//
//   node scripts/set-role.js you@example.com admin --project <id>
//   node scripts/set-role.js viewer@example.com demo --project <id>
//   node scripts/set-role.js someone@example.com none --project <id>
//
// The user must sign out and back in for the new claim to take effect.

require('./env');
const { getAuth } = require('../lib/firebase');

const ROLES = { admin: { admin: true }, demo: { demo: true }, none: {} };

async function main() {
  const [email, role] = process.argv.slice(2);
  if (!email || !ROLES[role]) {
    console.error('Usage: node scripts/set-role.js <email> <admin|demo|none> [--project <id>]');
    process.exit(1);
  }
  const user = await getAuth().getUserByEmail(email);
  await getAuth().setCustomUserClaims(user.uid, ROLES[role]);
  console.log(`${email} -> ${role}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);
