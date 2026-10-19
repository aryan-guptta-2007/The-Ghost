// functions/demo_action.js
/*
  Camera-free demo controls behind the dashboard's Demo panel.

  demoAction (HTTP POST /api/demo): staff only (admin or demo claim), and
  only on rooms flagged demo: true. Body: { roomId, action } where action is
    book      end whatever is running and book the room for the caller,
              with a 30s grace period and a 60s confirmation window
    vacant    inject a "room is empty" reading
    occupied  inject a "someone is here" reading
  Injected readings go through the same writeReading path as the edge
  device, so they trigger handleOccupancy exactly like real ones.

  schedulerTick (HTTP POST /api/tick): runs the sweep and reclaim jobs once.
  The emulator does not fire scheduled functions, so the dashboard and the
  simulator call this instead. It refuses to run outside the emulator.
*/

const { onRequest } = require('firebase-functions/v2/https');
const { db, Timestamp } = require('./lib/firebase');
const { HttpError, verifyBearer, isStaff, sendError } = require('./lib/auth');
const { ACTIVE_STATUSES } = require('./lib/config');
const { writeReading } = require('./receive_occupancy');
const { createBookingLogic } = require('./create_booking');
const { sweepActiveBookingsLogic } = require('./sweep_active_bookings');
const { cancelUnconfirmedBookingsLogic } = require('./cancel_unconfirmed_booking');

const DEMO_POLICY = { demo: true, graceSeconds: 30, confirmWindowSeconds: 60 };

async function demoLogic(token, { roomId, action }) {
  if (!isStaff(token)) throw new HttpError(403, 'Demo controls need an admin or demo account');
  if (!roomId) throw new HttpError(400, 'Missing roomId');
  const room = await db.collection('rooms').doc(roomId).get();
  if (!room.exists || room.get('demo') !== true) throw new HttpError(403, 'Not a demo room');

  const now = Timestamp.now();

  if (action === 'book') {
    const open = await db
      .collection('bookings')
      .where('roomId', '==', roomId)
      .where('status', 'in', ACTIVE_STATUSES)
      .get();
    const batch = db.batch();
    open.docs
      .filter((d) => d.get('endTime').toMillis() > now.toMillis())
      .forEach((d) => batch.update(d.ref, { status: 'completed', completedAt: now, endedBy: 'demo_reset' }));
    await batch.commit();
    return createBookingLogic(
      token.uid,
      { roomId, startTime: now.toDate().toISOString(), durationMinutes: 60 },
      DEMO_POLICY
    );
  }

  if (action === 'vacant' || action === 'occupied') {
    await writeReading({
      roomId,
      humanPresent: action === 'occupied',
      confidence: action === 'occupied' ? 0.78 : 0,
      timestamp: now.toDate(),
      source: 'demo',
    });
    return { success: true, roomId, action };
  }

  throw new HttpError(400, 'action must be book, vacant or occupied');
}

const demoAction = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'Method Not Allowed' });
  }
  try {
    const token = await verifyBearer(req);
    return res.status(200).send(await demoLogic(token, req.body || {}));
  } catch (err) {
    return sendError(res, err, 'demoAction');
  }
});

const schedulerTick = onRequest({ cors: true }, async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    return res.status(404).send({ error: 'Not found' });
  }
  const sweep = await sweepActiveBookingsLogic();
  const reclaim = await cancelUnconfirmedBookingsLogic();
  return res.status(200).send({ sweep, reclaim });
});

module.exports = { demoAction, schedulerTick, demoLogic };
