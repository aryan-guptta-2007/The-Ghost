// backend/create_booking.js
/*
  POST /api/bookings: book a room.

  Requires a Firebase ID token. Body:
    { "roomId": "room_101", "startTime": "<ISO-8601>", "durationMinutes": 60 }

  Bookings go through this endpoint rather than direct client writes
  because the overlap check needs a transactional query, which security
  rules cannot express.
*/

const { db, Timestamp } = require('./lib/firebase');
const { HttpError } = require('./lib/auth');
const { ACTIVE_STATUSES, MIN_BOOKING_MINUTES, MAX_BOOKING_MINUTES } = require('./lib/config');

const MAX_ADVANCE_DAYS = 30;
// Allow a booking that "starts now" to be sent a few minutes late.
const BACKDATE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Creates the booking inside a transaction so two people cannot take the
 * same slot. `extra` lets demoAction add demo-only fields.
 */
async function createBookingLogic(uid, { roomId, startTime, durationMinutes }, extra = {}, nowMs = Date.now()) {
  if (!roomId || typeof roomId !== 'string') throw new HttpError(400, 'Missing roomId');
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Invalid startTime');
  const minutes = Number(durationMinutes);
  if (!Number.isInteger(minutes) || minutes < MIN_BOOKING_MINUTES || minutes > MAX_BOOKING_MINUTES) {
    throw new HttpError(400, `durationMinutes must be ${MIN_BOOKING_MINUTES}-${MAX_BOOKING_MINUTES}`);
  }
  if (start.getTime() < nowMs - BACKDATE_TOLERANCE_MS) throw new HttpError(400, 'startTime is in the past');
  if (start.getTime() > nowMs + MAX_ADVANCE_DAYS * 86_400_000) {
    throw new HttpError(400, `Bookings open ${MAX_ADVANCE_DAYS} days ahead`);
  }

  const startTs = Timestamp.fromDate(start);
  const endTs = Timestamp.fromMillis(start.getTime() + minutes * 60_000);
  const roomRef = db.collection('rooms').doc(roomId);
  const bookingRef = db.collection('bookings').doc();

  await db.runTransaction(async (tx) => {
    const room = await tx.get(roomRef);
    if (!room.exists) throw new HttpError(404, `Unknown room ${roomId}`);

    // Overlap: existing.start < new.end AND existing.end > new.start.
    // The second range is checked in JavaScript (one range field per query).
    const candidates = await tx.get(
      db
        .collection('bookings')
        .where('roomId', '==', roomId)
        .where('status', 'in', ACTIVE_STATUSES)
        .where('startTime', '<', endTs)
    );
    const clash = candidates.docs.find((d) => d.get('endTime').toMillis() > startTs.toMillis());
    if (clash) throw new HttpError(409, 'Room is already booked for part of that time');

    tx.create(bookingRef, {
      roomId,
      userId: uid,
      startTime: startTs,
      endTime: endTs,
      status: 'scheduled',
      createdAt: Timestamp.fromMillis(nowMs),
      ...extra,
    });
  });

  return { success: true, bookingId: bookingRef.id, startTime: start.toISOString(), endTime: endTs.toDate().toISOString() };
}

module.exports = { createBookingLogic };
