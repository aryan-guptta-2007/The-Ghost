// Adds a real room, or updates one. seed.js only creates demo rooms, and
// clients cannot write rooms at all.
//
//   node scripts/add-room.js room_201 "Seminar Room 201" --capacity 30 --power 4.3 --project <id>
//
// Without --project it writes to the local emulators. The room ID is what
// goes in the edge device's ROOM_ID. Re-running keeps the room's sensor state.

const { arg, projectId } = require('./env');
const { db } = require('../lib/firebase');
const { DEFAULT_ROOM_KW } = require('../lib/config');

async function main() {
  const [id, name] = process.argv.slice(2);
  const capacity = Number(arg('capacity', 0));
  const powerKw = Number(arg('power', DEFAULT_ROOM_KW));

  if (!/^[\w-]+$/.test(id || '') || !name || name.startsWith('--') || !(powerKw > 0) || !(capacity >= 0)) {
    console.error('Usage: node scripts/add-room.js <roomId> "<name>" [--capacity <seats>] [--power <kW>] [--project <id>]');
    process.exit(1);
  }
  await db.collection('rooms').doc(id).set({ name, capacity, powerKw }, { merge: true });
  console.log(`${id} ("${name}", ${capacity} seats, ${powerKw} kW) saved to ${projectId}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);
