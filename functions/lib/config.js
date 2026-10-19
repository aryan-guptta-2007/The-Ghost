// functions/lib/config.js
// Enforcement policy and shared constants. One place to tune timings.

const { defineSecret } = require('firebase-functions/params');

// Shared HMAC secret between edge devices and receiveOccupancy.
// Set with: firebase functions:secrets:set GHOST_HMAC_SECRET
// Emulator: put GHOST_HMAC_SECRET=... in functions/.secret.local
const HMAC_SECRET = defineSecret('GHOST_HMAC_SECRET');

// How long a booking may sit empty before the owner is warned.
const GRACE_SECONDS = 10 * 60;
// How long the owner has to answer the warning before the room is reclaimed.
const CONFIRM_WINDOW_SECONDS = 5 * 60;
// No reading for this long means the device is offline. Edge heartbeat is 60s.
const STALE_SECONDS = 3 * 60;
// Signed payloads older or newer than this are rejected.
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
// AC + lighting draw for a typical classroom, used when a room has no powerKw.
const DEFAULT_ROOM_KW = 4.3;

// Booking statuses that can still be enforced. 'active' is accepted for
// bookings imported from systems that use it.
const ACTIVE_STATUSES = ['scheduled', 'active'];

const MIN_BOOKING_MINUTES = 15;
const MAX_BOOKING_MINUTES = 4 * 60;

/**
 * Per-booking timing. A booking may carry shorter graceSeconds /
 * confirmWindowSeconds (the demo uses 30s / 60s). Overrides can only make
 * enforcement stricter, never looser, so a user cannot write a booking that
 * opts out of enforcement.
 */
function policyFor(booking) {
  const clamp = (value, min, max) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(Math.max(value, min), max)
      : max;
  return {
    graceSeconds: clamp(booking.graceSeconds, 0, GRACE_SECONDS),
    confirmWindowSeconds: clamp(booking.confirmWindowSeconds, 30, CONFIRM_WINDOW_SECONDS),
  };
}

/** kWh saved by switching off a room for the rest of its booking. */
function energySavedKwh(powerKw, remainingMs) {
  const kw = typeof powerKw === 'number' && powerKw > 0 ? powerKw : DEFAULT_ROOM_KW;
  const hours = Math.max(0, remainingMs) / 3_600_000;
  return Math.round(kw * hours * 1000) / 1000;
}

module.exports = {
  HMAC_SECRET,
  GRACE_SECONDS,
  CONFIRM_WINDOW_SECONDS,
  STALE_SECONDS,
  MAX_CLOCK_SKEW_SECONDS,
  DEFAULT_ROOM_KW,
  ACTIVE_STATUSES,
  MIN_BOOKING_MINUTES,
  MAX_BOOKING_MINUTES,
  policyFor,
  energySavedKwh,
};
