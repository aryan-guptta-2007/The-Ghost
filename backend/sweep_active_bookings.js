// backend/sweep_active_bookings.js
/*
  The time-driven path, run by scheduler.js every few minutes.

  Readings are judged as they arrive (occupancy.js). A ghost booking often
  produces no reading at all: the camera is dead, unplugged, or the room
  was never fitted. This sweep looks at every running booking and warns
  the owner if the room is

    vacant   lastReading.humanPresent == false
    stale    lastReading older than STALE_SECONDS (edge heartbeat is 5 min)
    missing  the room has never reported

  It also marks bookings whose endTime has passed as 'completed', which
  keeps the startTime <= now query from growing forever.

  The query filters status and startTime in Firestore and endTime in
  JavaScript, because Firestore rejects range filters on two fields.
*/

const { db, Timestamp } = require('./lib/firebase');
const { ACTIVE_STATUSES, STALE_SECONDS } = require('./lib/config');
const { graceElapsed, flagGhost } = require('./lib/enforcement');

/** Why this room looks like a ghost, or null if someone is there. */
function ghostReason(room, now) {
  const last = room && room.lastReading;
  if (!last) return 'No occupancy data ever received for room';
  const ageSeconds = Math.round((now.toMillis() - last.timestamp.toMillis()) / 1000);
  if (ageSeconds > STALE_SECONDS) {
    return `Device silent for ${ageSeconds}s (limit ${STALE_SECONDS}s)`;
  }
  if (last.humanPresent === false) return 'Room reads vacant';
  return null;
}

async function sweepActiveBookingsLogic(now = Timestamp.now()) {
  const snap = await db
    .collection('bookings')
    .where('status', 'in', ACTIVE_STATUSES)
    .where('startTime', '<=', now)
    .get();

  const result = { checked: 0, flagged: 0, inGrace: 0, completed: 0 };
  if (snap.empty) return result;

  const running = [];
  const finished = db.batch();
  for (const doc of snap.docs) {
    if (doc.get('endTime').toMillis() <= now.toMillis()) {
      finished.update(doc.ref, { status: 'completed', completedAt: now });
      result.completed += 1;
    } else if (!graceElapsed(doc.data(), now)) {
      result.inGrace += 1;
    } else {
      running.push(doc);
    }
  }
  if (result.completed) await finished.commit();
  if (!running.length) return result;

  // One batched read for every room involved, instead of a query per booking.
  const roomIds = [...new Set(running.map((d) => d.get('roomId')))];
  const roomSnaps = await db.getAll(...roomIds.map((id) => db.collection('rooms').doc(id)));
  const rooms = new Map(roomSnaps.map((s) => [s.id, s.exists ? s.data() : null]));

  for (const doc of running) {
    result.checked += 1;
    const reason = ghostReason(rooms.get(doc.get('roomId')), now);
    if (reason && (await flagGhost(doc, reason, 'sweep', now))) {
      result.flagged += 1;
      console.log(`[sweep] warned booking ${doc.id} in ${doc.get('roomId')}: ${reason}`);
    }
  }
  return result;
}

module.exports = { sweepActiveBookingsLogic, ghostReason };
