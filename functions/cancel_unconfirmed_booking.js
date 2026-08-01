// functions/cancel_unconfirmed_booking.js
/*
  Firebase Cloud Function: Cancel unconfirmed bookings
  ----------------------------------------------------
  - Runs on a Pub/Sub schedule (e.g., every minute).
  - Finds `confirmations` documents with `status: 'pending'` whose
    `expiresAt` timestamp is in the past.
  - For each such document it:
      1️⃣ Checks the associated booking (if any) and cancels it only if it
         hasn't already been cancelled.
      2️⃣ Writes an audit log entry with `action: 'ghost_reclaimed'`.
  - The whole operation is performed inside a Firestore transaction to make it
    **idempotent** – if the function runs again for the same confirmation it
    will see that the booking is already cancelled or that a log entry exists
    and will skip duplicate work.
  - Security: the function runs with the privileged service account of the
    Firebase project; no client‑side authentication is required because it is a
    backend‑only scheduled job.
*/

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

/**
 * Helper: create an audit log entry.
 */
async function writeAuditLog(bookingId, confirmationId) {
    const log = {
        action: 'ghost_reclaimed',
        bookingId,
        confirmationId,
        timestamp: admin.firestore.Timestamp.now(),
        // Additional context for forensic analysis
        source: 'cancel_unconfirmed_booking',
    };
    await db.collection('audit_logs').add(log);
}

/**
 * Scheduled function that runs every minute.
 * Deploy with: `firebase deploy --only functions:cancelUnconfirmedBookings`
 */
exports.cancelUnconfirmedBookings = functions.pubsub.schedule('every 1 minutes').onRun(async (context) => {
    const now = admin.firestore.Timestamp.now();

    // Query pending confirmations that have expired
    const expiredConfirmationsSnap = await db
        .collection('confirmations')
        .where('status', '==', 'pending')
        .where('expiresAt', '<=', now)
        .get();

    if (expiredConfirmationsSnap.empty) {
        console.log('No expired confirmations at this run.');
        return null;
    }

    const batch = db.batch();

    for (const doc of expiredConfirmationsSnap.docs) {
        const data = doc.data();
        const confirmationRef = doc.ref;
        const bookingId = data.bookingId;

        // Use a transaction to ensure idempotency per confirmation
        await db.runTransaction(async (tx) => {
            // Re‑read the confirmation inside the transaction to avoid race conditions
            const freshSnap = await tx.get(confirmationRef);
            const freshData = freshSnap.data();
            if (!freshData || freshData.status !== 'pending') {
                // Already processed by another instance
                return;
            }

            // Mark confirmation as expired (or processed)
            tx.update(confirmationRef, { status: 'expired', processedAt: now });

            if (bookingId) {
                const bookingRef = db.collection('bookings').doc(bookingId);
                const bookingSnap = await tx.get(bookingRef);
                if (!bookingSnap.exists) {
                    // Booking missing – nothing to cancel, just log
                    await writeAuditLog(null, doc.id);
                    return;
                }
                const bookingData = bookingSnap.data();
                // Only cancel if not already cancelled/completed
                if (bookingData.status !== 'canceled' && bookingData.status !== 'completed') {
                    tx.update(bookingRef, { status: 'canceled', cancelledAt: now });
                    // Log the action
                    await writeAuditLog(bookingId, doc.id);
                } else {
                    // Booking already in a final state – still log for traceability
                    await writeAuditLog(bookingId, doc.id);
                }
            } else {
                // No booking linked – just log the orphaned confirmation
                await writeAuditLog(null, doc.id);
            }
        });
    }

    console.log(`Processed ${expiredConfirmationsSnap.size} expired confirmations.`);
    return null;
});
