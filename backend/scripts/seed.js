// Seeds rooms, demo accounts and bookings.
//
//   node scripts/seed.js                                     local emulators
//   DEMO_PASSWORD=... node scripts/seed.js --project <id>    real project
//
// On a real project it creates the rooms and the read-only demo account
// only. It never creates an admin with a known password.

const { useEmulators, projectId } = require('./env');
const { db, Timestamp, getAuth } = require('../lib/firebase');

const ROOMS = [
  { id: 'room_101', name: 'Seminar Room 101', capacity: 30, powerKw: 4.3 },
  { id: 'room_102', name: 'Lecture Hall 102', capacity: 120, powerKw: 9.5 },
  { id: 'room_103', name: 'Robotics Lab 103', capacity: 24, powerKw: 6.0 },
  { id: 'room_104', name: 'Study Pod 104', capacity: 4, powerKw: 1.2 },
];

const DEMO_EMAIL = 'demo@ghost-buster.test';
const ADMIN_EMAIL = 'admin@ghost-buster.test';
const EMULATOR_PASSWORD = 'ghostdemo';

async function upsertUser(email, password, claims) {
  const auth = getAuth();
  let user;
  try {
    user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password });
  } catch {
    user = await auth.createUser({ email, password, displayName: email.split('@')[0] });
  }
  await auth.setCustomUserClaims(user.uid, claims);
  return user.uid;
}

/** Bookings for the scripted demo: start now, demo-length timers. */
async function seedBookings(ownerId) {
  const now = Date.now();
  const batch = db.batch();
  for (const roomId of ['room_101', 'room_102', 'room_103']) {
    batch.set(db.collection('bookings').doc(`seed_${roomId}`), {
      roomId,
      userId: ownerId,
      status: 'scheduled',
      startTime: Timestamp.fromMillis(now),
      endTime: Timestamp.fromMillis(now + 60 * 60_000),
      createdAt: Timestamp.fromMillis(now),
      demo: true,
      graceSeconds: 30,
      confirmWindowSeconds: 60,
    });
  }
  await batch.commit();
}

async function seed() {
  const password = useEmulators ? EMULATOR_PASSWORD : process.env.DEMO_PASSWORD;
  if (!password) throw new Error('Set DEMO_PASSWORD to seed a real project');

  const batch = db.batch();
  for (const { id, ...room } of ROOMS) {
    batch.set(db.collection('rooms').doc(id), { ...room, demo: true }, { merge: true });
  }
  await batch.commit();

  const demoUid = await upsertUser(DEMO_EMAIL, password, { demo: true });
  console.log(`Seeded ${ROOMS.length} rooms in ${projectId}`);
  console.log(`Demo login: ${DEMO_EMAIL} / ${useEmulators ? password : '(DEMO_PASSWORD)'}`);

  if (useEmulators) {
    await upsertUser(ADMIN_EMAIL, EMULATOR_PASSWORD, { admin: true });
    await seedBookings(demoUid);
    console.log(`Admin login: ${ADMIN_EMAIL} / ${EMULATOR_PASSWORD}`);
  }
}

if (require.main === module) {
  seed().then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}

module.exports = { seed, DEMO_EMAIL, EMULATOR_PASSWORD };
