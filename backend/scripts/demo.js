// One-command local demo: `npm run demo` (runs inside the emulators).
//
// Starts the local API (the same handlers Vercel runs), seeds four rooms,
// then plays three stories through the real backend:
//   room_101  booked, nobody shows up   -> warned at ~30s, reclaimed ~60s later
//   room_102  booked, people present    -> left alone
//   room_103  booked, camera goes dead  -> warned once the device has been
//                                          silent for 3 min, then reclaimed
//   room_104  free, for you to drive from the dashboard's demo panel
//
// Every decision the backend makes is printed as it happens.

// Production treats a device as silent after 12 minutes (5-minute
// heartbeats). The demo heartbeats every 15s, so 3 minutes is plenty and
// keeps the dead-camera story short. Must be set before config loads.
process.env.GHOST_STALE_SECONDS = process.env.GHOST_STALE_SECONDS || '180';

const { seed, DEMO_EMAIL, EMULATOR_PASSWORD } = require('./seed');
const { startDevServer } = require('./dev-server');
const { send, secretFor } = require('./simulate');
const { LOCAL_API } = require('./env');
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
  startDevServer({ quiet: true });
  const secret = secretFor(LOCAL_API);

  console.log(`
  Dashboard:   http://127.0.0.1:5000
  Login:       ${DEMO_EMAIL} / ${EMULATOR_PASSWORD}
  API:         ${LOCAL_API}
  Emulator UI: http://127.0.0.1:4000

  Watching the backend (Ctrl+C to stop):`);
  narrate();

  // room_103 reports once, then its camera "dies".
  await send('room_103', 'occupied', secret, LOCAL_API);
  for (;;) {
    const results = await Promise.all([
      send('room_101', 'vacant', secret, LOCAL_API),
      send('room_102', 'occupied', secret, LOCAL_API),
    ]);
    for (const r of results.filter((r) => r.http !== 200)) {
      console.error(`  ! ${r.roomId} reading rejected: HTTP ${r.http} ${r.outcome || ''}`);
    }
    await new Promise((r) => setTimeout(r, EVERY_SECONDS * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
