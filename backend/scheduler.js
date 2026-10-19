// backend/scheduler.js
/*
  The periodic jobs, run by POST /api/cron (called every minute by an
  external scheduler such as cron-job.org) and, locally, by the dev server.

    reclaim  every call. Costs one read when nothing has expired, and a
             warned owner's window is only 5 minutes, so it must be prompt.
    sweep    every SWEEP_EVERY_MINUTES-th minute. It reads every running
             booking and its room, and its job is to catch silent devices,
             which are only declared silent after STALE_SECONDS anyway.
*/

const { Timestamp } = require('./lib/firebase');
const { SWEEP_EVERY_MINUTES } = require('./lib/config');
const { sweepActiveBookingsLogic } = require('./sweep_active_bookings');
const { cancelUnconfirmedBookingsLogic } = require('./cancel_unconfirmed_booking');

function sweepDue(now) {
  const minute = Math.floor(now.toMillis() / 60_000);
  return minute % SWEEP_EVERY_MINUTES === 0;
}

async function runScheduledJobs({ now = Timestamp.now(), forceSweep = false } = {}) {
  const reclaim = await cancelUnconfirmedBookingsLogic(now);
  const sweep = forceSweep || sweepDue(now) ? await sweepActiveBookingsLogic(now) : null;
  return { reclaim, sweep };
}

module.exports = { runScheduledJobs, sweepDue };
