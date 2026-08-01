// functions/decision_logger.js
// Helper to write immutable decision logs to Firestore collection "decision_logs".
// All fields are non‑PII. The collection is append‑only; security rules enforce no deletes/updates.

const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

/**
 * Log a decision made by any agent.
 * @param {string} agentName - e.g. 'VisionAgent', 'JudgeAgent', 'EnforcerAgent'
 * @param {string} decision - textual description of the action taken
 * @param {string} reason   - why the decision was made (e.g., rule, confidence)
 * @param {string} roomId   - affected room identifier
 * @param {string|null} bookingId - optional booking identifier
 */
async function logDecision(agentName, decision, reason, roomId, bookingId = null) {
    const doc = {
        agent_name: agentName,
        decision: decision,
        reason: reason,
        room_id: roomId,
        booking_id: bookingId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };
    // Use auto‑generated ID; security rules will prevent updates/deletes.
    await db.collection('decision_logs').add(doc);
}

module.exports = { logDecision };
