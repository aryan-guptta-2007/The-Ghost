// functions/index.js (updated handleOccupancy)
/*
  Firebase Cloud Function: Occupancy Enforcement
  -------------------------------------------------
  Updated to:
  • Prevent duplicate enforcement actions (idempotent writes).
  • Gracefully handle delayed or missing occupancy updates.
*/

const functions = require('firebase-functions');
const { admin, db } = require('./lib/firebase');

/**
 * Helper: create a unique enforcement key for a booking.
 * Using roomId + bookingId + detection window start ensures idempotency.
 */
function enforcementDocId(roomId, bookingId, detectionTs) {
  // Simple deterministic ID – can be any hash; using base64 of concatenated string.
  const raw = `${roomId}_${bookingId}_${detectionTs.seconds}`;
  return Buffer.from(raw).toString('base64');
}

exports.handleOccupancy = functions.firestore
  .document('occupancy/{occId}')
  .onCreate(async (snap, context) => {
    const occ = snap.data();
    const { roomId, timestamp, humanPresent, confidence } = occ;

    if (!roomId || !timestamp) {
      console.warn('Occupancy document missing required fields');
      return null;
    }

    const now = admin.firestore.Timestamp.now();
    const bookingsRef = db.collection('bookings');
    const activeBookingSnap = await bookingsRef
      .where('roomId', '==', roomId)
      .where('status', 'in', ['scheduled', 'active'])
      .where('startTime', '<=', now)
      .where('endTime', '>=', now)
      .limit(1)
      .get();

    if (activeBookingSnap.empty) {
      // No active booking – could be free use or missing booking.
      // Optional: log a "ghost occupancy without booking" event for audit.
      console.log(`No active booking for room ${roomId} at ${timestamp.toDate()}`);
      return null;
    }

    const bookingDoc = activeBookingSnap.docs[0];
    const bookingId = bookingDoc.id;
    const bookingStart = bookingDoc.get('startTime');

    // Compute elapsed time since booking start.
    const elapsedSec = now.seconds - bookingStart.seconds;
    const GRACE_SECONDS = 10 * 60; // 10 minutes

    // Only evaluate after the grace period.
    if (elapsedSec < GRACE_SECONDS) {
      console.log(`Grace period not elapsed for booking ${bookingId} (elapsed ${elapsedSec}s)`);
      return null;
    }

    // Determine if the room appears empty.
    const isEmpty = !humanPresent || confidence < 0.5;
    const decision = isEmpty ? 'abusive' : 'ok';
    const reason = isEmpty
      ? `No human detected 10 min after booking start (elapsed ${elapsedSec}s)`
      : 'Human presence confirmed';

    // Idempotent enforcement: generate a deterministic doc ID.
    const enfId = enforcementDocId(roomId, bookingId, timestamp);
    const enforcementRef = db.collection('enforcement').doc(enfId);

    // Use a transaction to ensure we don't duplicate.
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(enforcementRef);
      if (existing.exists) {
        // Already processed – skip duplicate.
        console.log(`Enforcement already exists for ${enfId}`);
        return;
      }
      const enforcementDoc = {
        roomId,
        bookingId,
        decision,
        reason,
        timestamp: now,
        status: decision === 'abusive' ? 'pending' : 'resolved',
      };
      tx.set(enforcementRef, enforcementDoc);
    });

    console.log(`Enforcement ${decision} recorded for booking ${bookingId}`);
    return null;
  });
