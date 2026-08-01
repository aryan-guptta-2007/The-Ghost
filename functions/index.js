// functions/index.js
/*
  Entry point for Firebase Cloud Functions.

  WHY THIS EXISTS:
  Firebase only deploys what is exported from this file. Previously
  index.js contained only handleOccupancy, which meant confirmAttendance,
  sendLateArrivalWarning and cancelUnconfirmedBookings were written but
  never deployed. This barrel re-exports every function.
*/

const { receiveOccupancy } = require('./receive_occupancy');
const { handleOccupancy } = require('./handle_occupancy');
const { sendLateArrivalWarning } = require('./late_arrival');
const { confirmAttendance } = require('./confirm_attendance');
const { cancelUnconfirmedBookings } = require('./cancel_unconfirmed_booking');

module.exports = {
  receiveOccupancy,           // HTTP  – ingest from edge device (HMAC signed)
  handleOccupancy,            // Firestore trigger – judge ghost vs. real
  sendLateArrivalWarning,     // Callable – push notification + confirm window
  confirmAttendance,          // HTTP  – user confirms they are present
  cancelUnconfirmedBookings,  // Scheduled – reclaim the room
};
