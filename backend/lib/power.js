// backend/lib/power.js
// Physical power switching and smart-relay / BMS integration for classrooms.
//
// When a ghost booking is reclaimed, this physically triggers the relay
// (Shelly, Tasmota, Tuya, Home Assistant, or campus BACnet controller) to
// switch OFF the lights and HVAC, converting theoretical estimates into
// real, measured kWh reductions.

const { db, Timestamp } = require('./firebase');

/**
 * Switch a room's physical power relay ON or OFF.
 * @param {string} roomId - Affected room ID
 * @param {'ON'|'OFF'} state - Target power relay state
 * @param {string} reason - Reason for switching (e.g. 'ghost_reclaimed', 'confirmed', 'booking_started')
 * @returns {Promise<{ success: boolean, state: string, liveSwitched: boolean }>}
 */
async function switchRoomPower(roomId, state, reason = 'manual') {
  const normalizedState = state.toUpperCase() === 'ON' ? 'ON' : 'OFF';
  const now = Timestamp.now();
  let liveSwitched = false;

  // 1. Physical Smart Relay / Webhook trigger (Shelly, MQTT, Home Assistant, etc.)
  const webhookUrl = process.env.POWER_RELAY_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const targetUrl = webhookUrl
        .replace('{roomId}', encodeURIComponent(roomId))
        .replace('{state}', encodeURIComponent(normalizedState.toLowerCase()));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Ghost-Resource-Buster-Power/1.0',
        },
        body: JSON.stringify({ roomId, state: normalizedState, reason, timestamp: new Date().toISOString() }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      liveSwitched = res.ok;
    } catch (err) {
      console.warn(`[power] Physical relay webhook failed for room ${roomId}: ${err.message}`);
    }
  }

  // 2. Persist state on room document in Firestore
  try {
    const roomRef = db.collection('rooms').doc(roomId);
    await roomRef.set(
      {
        powerState: normalizedState,
        lastPowerSwitch: {
          state: normalizedState,
          reason,
          timestamp: now,
          liveSwitched,
        },
      },
      { merge: true }
    );
  } catch (err) {
    console.warn(`[power] Failed to update powerState for room ${roomId}: ${err.message}`);
  }

  return { success: true, roomId, state: normalizedState, liveSwitched };
}

module.exports = { switchRoomPower };
