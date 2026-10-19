// functions/index.js
/*
  Entry point for Firebase Cloud Functions. Firebase only deploys what is
  exported here.

  Flow:
    receiveOccupancy -> occupancy/ -> handleOccupancy ---\
                                      sweepActiveBookings -+-> warn owner
    confirmAttendance (owner says "I'm here")               |
    cancelUnconfirmedBookings (no answer) -> reclaim room  <-/
*/

const { receiveOccupancy } = require('./receive_occupancy');
const { handleOccupancy } = require('./handle_occupancy');
const { sweepActiveBookings } = require('./sweep_active_bookings');
const { confirmAttendance } = require('./confirm_attendance');
const { cancelUnconfirmedBookings } = require('./cancel_unconfirmed_booking');
const { createBooking } = require('./create_booking');
const { demoAction, schedulerTick } = require('./demo_action');

module.exports = {
  receiveOccupancy,           // HTTP      – ingest from edge device (HMAC signed)
  handleOccupancy,            // Firestore – react to each reading
  sweepActiveBookings,        // Scheduled – catch silent/offline rooms every minute
  confirmAttendance,          // HTTP      – owner confirms they are present (ID token)
  cancelUnconfirmedBookings,  // Scheduled – reclaim the room, record energy saved
  createBooking,              // HTTP      – book a room (ID token, overlap-checked)
  demoAction,                 // HTTP      – camera-free demo controls (staff only)
  schedulerTick,              // HTTP      – emulator-only stand-in for the scheduler
};
