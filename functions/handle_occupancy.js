// functions/handle_occupancy.js
/*
  handleOccupancy (Firestore trigger on occupancy/{occId}): the fast path.
  Reacts to a reading the moment it lands.

    vacant   + booking past its grace period -> flagGhost (warn the owner)
    occupied + an open warning               -> clearByPresence

  Silence (dead camera, unplugged device) produces no reading, so this
  trigger can never see it. sweepActiveBookings covers that case.
*/

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { Timestamp } = require('./lib/firebase');
const {
  findActiveBooking,
  graceElapsed,
  flagGhost,
  clearByPresence,
} = require('./lib/enforcement');

/** Returns what happened, for logs and tests. */
async function evaluateReading(occ, now = Timestamp.now()) {
  const { roomId, humanPresent } = occ;
  if (!roomId) return 'invalid';

  const bookingDoc = await findActiveBooking(roomId, now);
  if (!bookingDoc) return 'no_booking';

  // The edge device already debounces 7 of 10 frames, so its verdict is
  // used as-is. Confidence is informational.
  if (humanPresent) {
    return (await clearByPresence(bookingDoc.id, now)) ? 'cleared' : 'present';
  }
  if (!graceElapsed(bookingDoc.data(), now)) return 'in_grace';

  const created = await flagGhost(bookingDoc, 'Room reads vacant after grace period', 'occupancy_trigger', now);
  return created ? 'warned' : 'already_warned';
}

const handleOccupancy = onDocumentCreated('occupancy/{occId}', async (event) => {
  const occ = event.data && event.data.data();
  if (!occ) return;
  const outcome = await evaluateReading(occ);
  console.log(`handleOccupancy ${event.params.occId} room=${occ.roomId}: ${outcome}`);
});

module.exports = { handleOccupancy, evaluateReading };
