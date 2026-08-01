// functions/cancel_unconfirmed_booking.js
/*
  Firebase Cloud Function: Cancel unconfirmed bookings (scheduled)
  ----------------------------------------------------------------
  Finds `confirmations` documents still 'pending' whose `expiresAt` has
  passed, cancels the linked booking, releases the room back to the pool,
  and writes an audit log.

  FIXES APPLIED vs. the original version:
   1. Firestore transactions require ALL reads before ANY writes. The
      original called tx.update(confirmationRef, ...) and only then
      tx.get(bookingRef) — that throws at runtime. Reads are now hoisted.
   2. writeAuditLog() did a non-transactional db.collection().add() from
      INSIDE the transaction. Transactions retry on contention, so that
      produced duplicate audit rows and broke the idempotency the comments
      claimed. The audit write is now a tx.set() with a deterministic ID.
   3. An unused db.batch() was created and never committed — removed.
   4. Cancelling a booking did not free the room. The room is now flipped
      back to available, which is the actual product value.
*/

const functions = require('firebase-functions');
const { admin, db } = require('./lib/firebase');

const SCHEDULE = 'every 1 minutes';

exports.cancelUnconfirmedBookings = functions.pubsub
  .schedule(SCHEDULE)
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();

    const expiredSnap = await db
      .collection('confirmations')
      .where('status', '==', 'pending')
      .where('expiresAt', '<=', now)
      .limit(100) // bound the work per run
      .get();

    if (expiredSnap.empty) {
      console.log('No expired confirmations at this run.');
      return null;
    }

    let reclaimed = 0;

    for (const doc of expiredSnap.docs) {
      const confirmationRef = doc.ref;
      const { bookingId, roomId } = doc.data();

      try {
        await db.runTransaction(async (tx) => {
          // ---------- ALL READS FIRST ----------
          const freshSnap = await tx.get(confirmationRef);
          const fresh = freshSnap.data();

          // Already handled by a concurrent run — idempotent no-op.
          if (!fresh || fresh.status !== 'pending') return;

          const bookingRef = bookingId
            ? db.collection('bookings').doc(bookingId)
            : null;
          const bookingSnap = bookingRef ? await tx.get(bookingRef) : null;

          const roomRef = roomId ? db.collection('rooms').doc(roomId) : null;

          // ---------- THEN ALL WRITES ----------
          tx.update(confirmationRef, {
            status: 'expired',
            processedAt: now,
          });

          let cancelled = false;
          if (bookingSnap && bookingSnap.exists) {
            const status = bookingSnap.get('status');
            if (status !== 'canceled' && status !== 'completed') {
              tx.update(bookingRef, {
                status: 'canceled',
                cancelledAt: now,
                cancelReason: 'ghost_reclaimed',
              });
              cancelled = true;
            }
          }

          // Release the room so someone else can book the slot.
          if (roomRef && cancelled) {
            tx.set(
              roomRef,
              { available: true, releasedAt: now, releasedBy: 'ghost_buster' },
              { merge: true }
            );
          }

          // Deterministic audit ID => transaction retries overwrite rather
          // than duplicate.
          const auditRef = db.collection('audit_logs').doc(`ghost_${doc.id}`);
          tx.set(auditRef, {
            action: 'ghost_reclaimed',
            bookingId: bookingId || null,
            roomId: roomId || null,
            confirmationId: doc.id,
            bookingCancelled: cancelled,
            timestamp: now,
            source: 'cancel_unconfirmed_booking',
          });
        });
        reclaimed += 1;
      } catch (err) {
        console.error(`Failed to process confirmation ${doc.id}:`, err);
      }
    }

    console.log(`Processed ${reclaimed}/${expiredSnap.size} expired confirmations.`);
    return null;
  });
