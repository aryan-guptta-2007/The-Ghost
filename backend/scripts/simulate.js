// Camera-free edge device. Sends correctly signed readings, exactly as
// edge_ai/metadata_sender.py would.
//
//   node scripts/simulate.js room_101=vacant room_102=occupied       local dev server
//   node scripts/simulate.js room_101=vacant --every 300             repeat every 5 min
//   GHOST_HMAC_SECRET=... node scripts/simulate.js room_101=vacant \
//     --api https://<your-app>.vercel.app/api                         production
//
// A room left out of the list sends nothing, which is how a dead camera
// looks to the backend.

const { arg, apiBase, LOCAL_API } = require('./env');
const { sign } = require('../lib/hmac');

function secretFor(base) {
  if (process.env.GHOST_HMAC_SECRET) return process.env.GHOST_HMAC_SECRET;
  if (base === LOCAL_API) return 'local-dev-secret'; // matches lib/config.js in emulator mode
  throw new Error('Set GHOST_HMAC_SECRET to the value configured in Vercel');
}

async function send(roomId, status, secret, base = apiBase) {
  const payload = {
    room_id: roomId,
    status,
    confidence: status === 'occupied' ? 0.78 : 0,
    timestamp: new Date().toISOString(),
  };
  payload.signature = sign(payload, secret);
  const res = await fetch(`${base}/occupancy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { roomId, status, http: res.status, outcome: body.outcome || body.error };
}

async function main() {
  const readings = process.argv
    .slice(2)
    .filter((a) => a.includes('=') && !a.startsWith('--'))
    .map((a) => a.split('='));
  if (!readings.length || readings.some(([, s]) => !['occupied', 'vacant'].includes(s))) {
    console.error('Usage: node scripts/simulate.js <roomId>=<occupied|vacant> ... [--every <seconds>] [--api <url>]');
    process.exit(1);
  }
  const secret = secretFor(apiBase);
  const every = Number(arg('every', 0));
  do {
    const results = await Promise.all(readings.map(([room, status]) => send(room, status, secret)));
    console.log(
      new Date().toLocaleTimeString(),
      results.map((r) => `${r.roomId}=${r.status} -> ${r.http} ${r.outcome || ''}`).join('  ')
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

module.exports = { send, secretFor };
