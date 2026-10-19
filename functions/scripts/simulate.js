// Camera-free edge device. Sends correctly signed readings, exactly as
// edge_ai/metadata_sender.py would.
//
//   node scripts/simulate.js room_101=vacant room_102=occupied
//   node scripts/simulate.js room_101=vacant --every 20       repeat every 20s
//   node scripts/simulate.js room_101=vacant --project <id>   real project
//
// A room left out of the list sends nothing, which is how a dead camera
// looks to the backend.

const { arg, useEmulators, functionsBase, hmacSecret } = require('./env');
const { sign } = require('../lib/hmac');

async function send(roomId, status, secret) {
  const payload = {
    room_id: roomId,
    status,
    confidence: status === 'occupied' ? 0.78 : 0,
    timestamp: new Date().toISOString(),
  };
  payload.signature = sign(payload, secret);
  const res = await fetch(`${functionsBase}/receiveOccupancy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { roomId, status, http: res.status };
}

/** Runs the sweep and reclaim jobs once. Emulator only; Cloud Scheduler does this in production. */
async function tick() {
  if (!useEmulators) return null;
  const res = await fetch(`${functionsBase}/schedulerTick`, { method: 'POST' });
  return res.ok ? res.json() : null;
}

async function round(readings, secret) {
  const results = await Promise.all(readings.map(([room, status]) => send(room, status, secret)));
  await tick();
  return results;
}

async function main() {
  const readings = process.argv
    .slice(2)
    .filter((a) => a.includes('='))
    .map((a) => a.split('='));
  if (!readings.length || readings.some(([, s]) => !['occupied', 'vacant'].includes(s))) {
    console.error('Usage: node scripts/simulate.js <roomId>=<occupied|vacant> ... [--every <seconds>]');
    process.exit(1);
  }
  const secret = hmacSecret();
  const every = Number(arg('every', 0));
  do {
    const results = await round(readings, secret);
    console.log(
      new Date().toLocaleTimeString(),
      results.map((r) => `${r.roomId}=${r.status} -> ${r.http}`).join('  ')
    );
    if (every) await new Promise((r) => setTimeout(r, every * 1000));
  } while (every);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { send, tick, round };
