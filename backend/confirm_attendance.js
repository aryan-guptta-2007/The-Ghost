// backend/confirm_attendance.js
/*
  POST /api/confirm: the booking owner answers a
  ghost warning with "I'm here".

  Requires "Authorization: Bearer <Firebase ID token>". The caller must be
  the user who owns the booking; a confirmationId alone is not enough.
  Body: { "confirmationId": "<bookingId>" }
*/

const { db, FieldValue, Timestamp } = require('./lib/firebase');
const { HttpError } = require('./lib/auth');
const { statsRef } = require('./lib/enforcement');
const { logDecision } = require('./decision_logger');

async function confirmLogic(uid, confirmationId, now = Timestamp.now()) {
  if (!confirmationId || typeof confirmationId !== 'string') {
    throw new HttpError(400, 'Missing confirmationId');
  }
  const confirmationRef = db.collection('confirmations').doc(confirmationId);

  const conf = await db.runTransaction(async (tx) => {
    const snap = await tx.get(confirmationRef);
    if (!snap.exists) throw new HttpError(404, 'Confirmation not found');
    const data = snap.data();
    if (data.userId !== uid) throw new HttpError(403, 'Not your booking');
    if (data.status !== 'pending') throw new HttpError(409, `Already ${data.status}`);
    if (data.expiresAt.toMillis() <= now.toMillis()) {
      // Leave the state change to the reclaim job so the reclaim
      // and its audit entry stay in one place.
      throw new HttpError(410, 'Confirmation window has expired');
    }
    tx.update(confirmationRef, { status: 'confirmed', resolvedAt: now });
    tx.update(db.collection('enforcement').doc(data.bookingId), {
      status: 'confirmed',
      resolvedAt: now,
    });
    tx.set(statsRef(), { warningsConfirmed: FieldValue.increment(1) }, { merge: true });
    return data;
  });

  await logDecision('EnforcerAgent', 'confirmed', 'Owner confirmed attendance', conf.roomId, conf.bookingId);
  return { success: true, confirmationId };
}

module.exports = { confirmLogic };
