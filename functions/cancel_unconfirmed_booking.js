// functions/cancel_unconfirmed_booking.js
/*
  cancelUnconfirmedBookings (scheduled, every minute): the reclaim step.

  For every confirmation still 'pending' after expiresAt:
    - cancel the booking (if it is still running)
    - mark the enforcement record 'reclaimed'
    - write audit_logs/ghost_{bookingId} with the energy saved, computed as
      the room's power draw x the booking time that was left
    - bump the dashboard counters in stats/global

  All reads happen before any write (Firestore transaction rule), and the
  audit doc has a deterministic ID, so a retried transaction overwrites
  instead of duplicating.
*/

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { db, FieldValue, Timestamp } = require('./lib/firebase');
const { ACTIVE_STATUSES, DEFAULT_ROOM_KW, energySavedKwh } = require('./lib/config');
const { statsRef } = require('./lib/enforcement');
const { logDecision } = require('./decision_logger');


/** Reclaims one expired confirmation. Returns the audit entry, or null. */
async function reclaimOne(confirmationRef, now) {
  return db.runTransaction(async (tx) => {
    // ---------- ALL READS FIRST ----------
    const conf = await tx.get(confirmationRef);
    if (!conf.exists || conf.get('status') !== 'pending') return null;

    const { bookingId, roomId } = conf.data();
    const bookingRef = db.collection('bookings').doc(bookingId);
    const roomRef = db.collection('rooms').doc(roomId);
    const enforcementRef = db.collection('enforcement').doc(bookingId);
    const [booking, room, enforcement] = await tx.getAll(bookingRef, roomRef, enforcementRef);

    // ---------- THEN ALL WRITES ----------
    tx.update(confirmationRef, { status: 'expired', resolvedAt: now });

    const stillRunning =
      booking.exists &&
      ACTIVE_STATUSES.includes(booking.get('status')) &&
      booking.get('endTime').toMillis() > now.toMillis();

    const powerKw = (room.exists && room.get('powerKw')) || DEFAULT_ROOM_KW;
    const remainingMs = stillRunning ? booking.get('endTime').toMillis() - now.toMillis() : 0;
    const kwh = energySavedKwh(powerKw, remainingMs);

    if (stillRunning) {
      tx.update(bookingRef, {
        status: 'canceled',
        cancelledAt: now,
        cancelReason: 'ghost_reclaimed',
      });
      tx.set(roomRef, { lastReclaimAt: now }, { merge: true });
      tx.set(
        statsRef(),
        {
          roomsReclaimed: FieldValue.increment(1),
          energySavedKwh: FieldValue.increment(kwh),
          minutesReclaimed: FieldValue.increment(Math.round(remainingMs / 60000)),
        },
        { merge: true }
      );
    }
    if (enforcement.exists) {
      tx.update(enforcementRef, {
        status: stillRunning ? 'reclaimed' : 'expired',
        resolvedAt: now,
      });
    }

    const audit = {
      action: stillRunning ? 'ghost_reclaimed' : 'warning_expired',
      bookingId,
      roomId,
      confirmationId: conf.id,
      bookingCancelled: stillRunning,
      remainingMinutes: Math.round(remainingMs / 60000),
      powerKw,
      energySavedKwh: kwh,
      timestamp: now,
      source: 'cancel_unconfirmed_booking',
    };
    tx.set(db.collection('audit_logs').doc(`ghost_${bookingId}`), audit);
    return audit;
  });
}

async function cancelUnconfirmedBookingsLogic(now = Timestamp.now()) {
  const expired = await db
    .collection('confirmations')
    .where('status', '==', 'pending')
    .where('expiresAt', '<=', now)
    .limit(100) // bound the work per run
    .get();

  let reclaimed = 0;
  for (const doc of expired.docs) {
    try {
      const audit = await reclaimOne(doc.ref, now);
      if (audit && audit.bookingCancelled) {
        reclaimed += 1;
        await logDecision(
          'ReclaimAgent',
          'reclaimed',
          `No confirmation; released ${audit.remainingMinutes} min, saved ${audit.energySavedKwh} kWh`,
          audit.roomId,
          audit.bookingId
        );
      }
    } catch (err) {
      console.error(`Failed to process confirmation ${doc.id}:`, err);
    }
  }
  return { expired: expired.size, reclaimed };
}

const cancelUnconfirmedBookings = onSchedule('every 1 minutes', async () => {
  const result = await cancelUnconfirmedBookingsLogic();
  console.log('[reclaim] done', result);
});

module.exports = { cancelUnconfirmedBookings, cancelUnconfirmedBookingsLogic };
