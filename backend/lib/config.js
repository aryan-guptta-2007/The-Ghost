// backend/lib/config.js
// Enforcement policy, secrets and shared constants. One place to tune timings.
//
// The timings are sized for Firestore's free (Spark) daily quota; see
// "Running for free" in the README for the arithmetic.

const { usingEmulator } = require('./firebase');

/**
 * A secret from the environment. In production these are Vercel env vars.
 * Against the local emulators a fixed dev value is used so `npm run demo`
 * needs no setup; that fallback can never apply to a real project.
 */
function secret(name, devValue) {
  const value = process.env[name];
  if (value) return value;
  if (usingEmulator()) return devValue;
  throw new Error(`${name} is not set`);
}
const hmacSecret = () => secret('GHOST_HMAC_SECRET', 'local-dev-secret');
const cronSecret = () => secret('CRON_SECRET', 'local-cron-secret');

const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// How long a booking may sit empty before the owner is warned.
const GRACE_SECONDS = 10 * 60;
// How long the owner has to answer the warning before the room is reclaimed.
const CONFIRM_WINDOW_SECONDS = 5 * 60;
// No reading for this long means the device is offline. The edge heartbeat
// is 5 minutes, so this allows one missed heartbeat plus delivery delay.
const STALE_SECONDS = envInt('GHOST_STALE_SECONDS', 12 * 60);
// The cron endpoint is called every minute. Reclaiming runs every call (it
// costs one read when there is nothing to do); the full sweep of running
// bookings only every Nth minute, because live heartbeats are already
// evaluated as they arrive and the sweep is there to catch silent devices.
const SWEEP_EVERY_MINUTES = envInt('GHOST_SWEEP_EVERY_MINUTES', 5);
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
  hmacSecret,
  cronSecret,
  SWEEP_EVERY_MINUTES,
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
