// One-command local demo: `npm run demo` (runs inside the emulators).
//
// Seeds four rooms, then plays three stories through the real backend:
//   room_101  booked, nobody shows up   -> warned at ~30s, reclaimed ~60s later
//   room_102  booked, people present    -> left alone
//   room_103  booked, camera goes dead  -> warned once the device has been
//                                          silent for 3 min, then reclaimed
//   room_104  free, for you to drive from the dashboard's demo panel
//
// Every decision the backend makes is printed as it happens.

const { seed, DEMO_EMAIL, EMULATOR_PASSWORD } = require('./seed');
const { hmacSecret } = require('./env');
const { round, send } = require('./simulate');
const { db } = require('../lib/firebase');

const EVERY_SECONDS = 15;

function narrate() {
  const started = Date.now();
  db.collection('decision_logs')
    .orderBy('timestamp')
    .onSnapshot((snap) => {
      snap.docChanges().forEach(({ type, doc }) => {
        if (type !== 'added') return;
        const d = doc.data();
        const t = Math.round((Date.now() - started) / 1000);
        console.log(`  +${String(t).padStart(3)}s  ${String(d.room_id).padEnd(9)} ${d.agent_name}: ${d.decision} (${d.reason})`);
      });
    });
}

async function main() {
  await seed();
  const secret = hmacSecret();

  console.log(`
  Dashboard:   http://127.0.0.1:5000
  Login:       ${DEMO_EMAIL} / ${EMULATOR_PASSWORD}
  Emulator UI: http://127.0.0.1:4000

  Watching the backend (Ctrl+C to stop):`);
  narrate();

  // room_103 reports once, then its camera "dies".
  await send('room_103', 'occupied', secret);
  for (;;) {
    await round(
      [
        ['room_101', 'vacant'],
        ['room_102', 'occupied'],
      ],
      secret
    );
    await new Promise((r) => setTimeout(r, EVERY_SECONDS * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
