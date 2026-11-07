// backend/scheduler.js
/*
  The periodic jobs, run by POST /api/cron (called every minute by an
  external scheduler such as cron-job.org) and, locally, by the dev server.

    reclaim   every call. Costs one read when nothing has expired, and a
              warned owner's window is only 5 minutes, so it must be prompt.
    sweep     every SWEEP_EVERY_MINUTES-th minute. It reads every running
              booking and its room, and its job is to catch silent devices,
              which are only declared silent after STALE_SECONDS anyway.
    retention runs hourly to prune old decision_logs (>30 days), protecting
              the Spark plan's 1 GiB free storage ceiling indefinitely.
*/

const { db, Timestamp } = require('./lib/firebase');
const { SWEEP_EVERY_MINUTES } = require('./lib/config');
const { sweepActiveBookingsLogic } = require('./sweep_active_bookings');
const { cancelUnconfirmedBookingsLogic } = require('./cancel_unconfirmed_booking');

const LOG_RETENTION_DAYS = 30;

function sweepDue(now) {
  const minute = Math.floor(now.toMillis() / 60_000);
  return minute % SWEEP_EVERY_MINUTES === 0;
}

function retentionDue(now) {
  const minute = Math.floor(now.toMillis() / 60_000);
  return minute % 60 === 0;
}

/** Prunes old decision logs to prevent unbounded storage growth. */
async function pruneOldRecords(now) {
  const cutoff = Timestamp.fromMillis(now.toMillis() - LOG_RETENTION_DAYS * 86_400_000);
  try {
    const oldLogs = await db
      .collection('decision_logs')
      .where('timestamp', '<', cutoff)
      .limit(50)
      .get();

    if (!oldLogs.empty) {
      const batch = db.batch();
      oldLogs.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      return { pruned: oldLogs.size };
    }
  } catch (err) {
    console.warn('[scheduler] Retention pruning skipped:', err.message);
  }
  return { pruned: 0 };
}

async function runScheduledJobs({ now = Timestamp.now(), forceSweep = false } = {}) {
  const reclaim = await cancelUnconfirmedBookingsLogic(now);
  const sweep = forceSweep || sweepDue(now) ? await sweepActiveBookingsLogic(now) : null;
  const retention = retentionDue(now) ? await pruneOldRecords(now) : null;
  return { reclaim, sweep, retention };
}

module.exports = { runScheduledJobs, sweepDue, pruneOldRecords, retentionDue };
