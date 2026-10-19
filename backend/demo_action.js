// backend/demo_action.js
/*
  Camera-free demo controls behind the dashboard's Demo panel
  (POST /api/demo). Staff only (admin or demo claim), and only on rooms
  flagged demo: true. Body: { roomId, action } where action is
    book      end whatever is running and book the room for the caller,
              with a 30s grace period and a 60s confirmation window
    vacant    inject a "room is empty" reading
    occupied  inject a "someone is here" reading
  Injected readings are stored and judged by the same code as edge
  readings, so they warn and clear exactly like real ones.
*/

const { db, Timestamp } = require('./lib/firebase');
const { HttpError, isStaff } = require('./lib/auth');
const { ACTIVE_STATUSES } = require('./lib/config');
const { writeReading, evaluateReading } = require('./occupancy');
const { createBookingLogic } = require('./create_booking');

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
    const humanPresent = action === 'occupied';
    await writeReading({
      roomId,
      humanPresent,
      confidence: humanPresent ? 0.78 : 0,
      timestamp: now.toDate(),
      source: 'demo',
    });
    const outcome = await evaluateReading({ roomId, humanPresent }, now);
    return { success: true, roomId, action, outcome };
  }

  throw new HttpError(400, 'action must be book, vacant or occupied');
}

module.exports = { demoLogic };
