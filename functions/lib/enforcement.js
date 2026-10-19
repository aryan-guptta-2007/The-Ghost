// functions/lib/enforcement.js
/*
  The enforcement chain, shared by handleOccupancy (event-driven) and
  sweepActiveBookings (time-driven):

    flagGhost        booking is empty past its grace period
                     -> enforcement/{bookingId}   status 'warned'
                     -> confirmations/{bookingId} status 'pending'
                     -> FCM push to the booking owner (best effort)
    clearByPresence  a person shows up before the window closes
                     -> both docs move to 'cleared'
    confirmAttendance / cancelUnconfirmedBookings close the loop.

  Both docs are keyed by bookingId, so a booking is warned at most once no
  matter how many readings or sweeps notice it.
*/

const { db, FieldValue, Timestamp, getMessaging } = require('./firebase');
const { ACTIVE_STATUSES, policyFor } = require('./config');
const { logDecision } = require('../decision_logger');

const statsRef = () => db.collection('stats').doc('global');

/**
 * The booking currently running in a room, or null. Firestore cannot range
 * filter startTime and endTime in one query, so endTime is checked here.
 */
async function findActiveBooking(roomId, now) {
  const snap = await db
    .collection('bookings')
    .where('roomId', '==', roomId)
    .where('status', 'in', ACTIVE_STATUSES)
    .where('startTime', '<=', now)
    .get();
  const running = snap.docs.filter((d) => d.get('endTime').toMillis() > now.toMillis());
  // Latest start wins if bad data ever produces an overlap.
  running.sort((a, b) => b.get('startTime').toMillis() - a.get('startTime').toMillis());
  return running[0] || null;
}

function graceElapsed(booking, now) {
  const { graceSeconds } = policyFor(booking);
  return now.toMillis() - booking.startTime.toMillis() >= graceSeconds * 1000;
}

/**
 * Warn the owner of an apparently empty booking. Returns true if this call
 * created the warning, false if it already existed or the booking ended.
 */
async function flagGhost(bookingDoc, reason, source, now) {
  const booking = bookingDoc.data();
  const bookingId = bookingDoc.id;
  const { roomId, userId } = booking;
  const { confirmWindowSeconds } = policyFor(booking);
  const expiresAt = Timestamp.fromMillis(now.toMillis() + confirmWindowSeconds * 1000);

  const enforcementRef = db.collection('enforcement').doc(bookingId);
  const confirmationRef = db.collection('confirmations').doc(bookingId);

  const created = await db.runTransaction(async (tx) => {
    const [existing, fresh] = await tx.getAll(enforcementRef, bookingDoc.ref);
    if (existing.exists) return false;
    if (!fresh.exists || !ACTIVE_STATUSES.includes(fresh.get('status'))) return false;

    tx.set(enforcementRef, {
      bookingId,
      roomId,
      userId: userId || null,
      reason,
      source,
      status: 'warned',
      createdAt: now,
    });
    tx.set(confirmationRef, {
      bookingId,
      roomId,
      userId: userId || null,
      status: 'pending',
      createdAt: now,
      expiresAt,
      notified: false,
    });
    tx.set(statsRef(), { ghostsFlagged: FieldValue.increment(1) }, { merge: true });
    return true;
  });

  if (!created) return false;

  await logDecision('EnforcerAgent', 'warned', reason, roomId, bookingId);
  const notified = await sendWarning(userId, roomId, bookingId, confirmWindowSeconds);
  await confirmationRef.update({ notified });
  return true;
}

/** A person was detected: stand down any open warning for this booking. */
async function clearByPresence(bookingId, now) {
  const confirmationRef = db.collection('confirmations').doc(bookingId);
  const enforcementRef = db.collection('enforcement').doc(bookingId);

  const cleared = await db.runTransaction(async (tx) => {
    const conf = await tx.get(confirmationRef);
    if (!conf.exists || conf.get('status') !== 'pending') return false;
    tx.update(confirmationRef, { status: 'cleared', resolvedAt: now });
    tx.update(enforcementRef, { status: 'cleared', resolvedAt: now });
    tx.set(statsRef(), { warningsCleared: FieldValue.increment(1) }, { merge: true });
    return true;
  });

  if (cleared) {
    const roomId = (await confirmationRef.get()).get('roomId');
    await logDecision('JudgeAgent', 'cleared', 'Person detected after warning', roomId, bookingId);
  }
  return cleared;
}

/**
 * Push the warning to the owner's device. Best effort: the warning is
 * also visible in the dashboard's "My bookings" view, so a missing token
 * or an FCM failure must never stop enforcement.
 */
async function sendWarning(userId, roomId, bookingId, windowSeconds) {
  if (!userId) return false;
  try {
    const user = await db.collection('users').doc(userId).get();
    const token = user.exists ? user.get('fcmToken') : null;
    if (!token) return false;
    const minutes = Math.max(1, Math.round(windowSeconds / 60));
    await getMessaging().send({
      token,
      notification: {
        title: 'Is anyone in your room?',
        body: `Your booking for ${roomId} looks empty. Confirm within ${minutes} min or the room will be released.`,
      },
      data: { type: 'ghost_warning', bookingId, confirmationId: bookingId, roomId },
    });
    return true;
  } catch (err) {
    console.error(`FCM send failed for booking ${bookingId}:`, err.message);
    return false;
  }
}

module.exports = { findActiveBooking, graceElapsed, flagGhost, clearByPresence, statsRef };
