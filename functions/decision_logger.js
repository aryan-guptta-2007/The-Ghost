// functions/decision_logger.js
// Helper to write immutable decision logs to Firestore collection "decision_logs".
// All fields are non-PII. The collection is append-only; firestore.rules deny
// client writes, updates and deletes.

const { db, FieldValue } = require('./lib/firebase');

/**
 * Log a decision made by any agent.
 * @param {string} agentName - e.g. 'JudgeAgent', 'EnforcerAgent', 'ReclaimAgent'
 * @param {string} decision - short action name, e.g. 'warned', 'reclaimed'
 * @param {string} reason   - why the decision was made (e.g., rule, confidence)
 * @param {string} roomId   - affected room identifier
 * @param {string|null} bookingId - optional booking identifier
 */
async function logDecision(agentName, decision, reason, roomId, bookingId = null) {
  await db.collection('decision_logs').add({
    agent_name: agentName,
    decision,
    reason,
    room_id: roomId || null,
    booking_id: bookingId,
    timestamp: FieldValue.serverTimestamp(),
  });
}

module.exports = { logDecision };
