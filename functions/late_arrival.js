// functions/late_arrival.js
/*
  Firebase Cloud Function: Late Arrival Warning
  -------------------------------------------------
  - HTTP callable function that receives a userId, roomId, and bookingId.
  - Looks up the user's FCM token (stored in `users/{userId}`).
  - Sends a push notification warning the user about a late arrival.
  - Creates a confirmation document that expires after 5 minutes.
  - The expiration can be handled by a separate scheduled function or a
    Firestore TTL policy.
*/

const functions = require('firebase-functions');
const { admin, db } = require('./lib/firebase');

/**
 * Callable Cloud Function: sendLateArrivalWarning
 *
 * Expected data payload:
 *   {
 *     userId: string,   // UID of the user to notify
 *     roomId: string,   // Human‑readable room identifier
 *     bookingId: string // Booking document ID (optional, for reference)
 *   }
 */
exports.sendLateArrivalWarning = functions.https.onCall(async (data, context) => {
    // Basic auth check – ensure the caller is authenticated
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Request must be authenticated');
    }

    const { userId, roomId, bookingId } = data;
    if (!userId || !roomId) {
        throw new functions.https.HttpsError('invalid-argument', 'userId and roomId are required');
    }

    // -------------------------------------------------------------------
    // 1️⃣ Retrieve the user's FCM token from Firestore
    // -------------------------------------------------------------------
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
        throw new functions.https.HttpsError('not-found', `User ${userId} not found`);
    }
    const fcmToken = userDoc.get('fcmToken');
    if (!fcmToken) {
        throw new functions.https.HttpsError('failed-precondition', `User ${userId} has no FCM token`);
    }

    // -------------------------------------------------------------------
    // 2️⃣ Build the notification payload
    // -------------------------------------------------------------------
    const notification = {
        title: 'Late Arrival Warning',
        body: `Your booking for ${roomId} is about to start. Please confirm within 5 minutes.`,
    };

    const message = {
        token: fcmToken,
        notification,
        data: {
            roomId,
            bookingId: bookingId || '',
            type: 'late_arrival',
        },
    };

    // -------------------------------------------------------------------
    // 3️⃣ Send the push notification via FCM
    // -------------------------------------------------------------------
    try {
        await admin.messaging().send(message);
    } catch (err) {
        console.error('FCM send error:', err);
        throw new functions.https.HttpsError('internal', 'Failed to send push notification');
    }

    // -------------------------------------------------------------------
    // 4️⃣ Create a confirmation document with a 5‑minute expiry
    // -------------------------------------------------------------------
    const now = admin.firestore.Timestamp.now();
    const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 5 * 60 * 1000)); // 5 minutes later

    const confirmation = {
        userId,
        roomId,
        bookingId: bookingId || null,
        status: 'pending', // will be updated by the client when they confirm
        createdAt: now,
        expiresAt,
    };

    const confirmationRef = await db.collection('confirmations').add(confirmation);

    // -------------------------------------------------------------------
    // 5️⃣ Return a concise result to the caller
    // -------------------------------------------------------------------
    return {
        success: true,
        confirmationId: confirmationRef.id,
        message: 'Late arrival warning sent and confirmation timer started',
    };
});
