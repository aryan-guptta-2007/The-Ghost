# energy/energy_controller.py
"""Mock Energy Controller for Ghost Resource Buster.

Purpose
-------
- Simulate turning *off* HVAC (AC) and lights when a room is unclaimed
  (i.e., no human detected for the duration of a booking).
- Log an estimated energy‑saving value that can later be replaced by a
  real IoT controller.
- Provides a tiny public API (`update_room_status`) that the rest of the
  system can call whenever occupancy metadata changes.

Why a mock?
------------
During MVP development we want zero hardware dependencies.  This module
stores state in memory and writes human‑readable logs to Firestore (or a
local file) so that the behaviour can be verified in tests and later
replaced with a real controller that talks to smart plugs, Zigbee, etc.
"""

import os
import json
from datetime import datetime, timezone
from typing import Dict, Any

# ----------------------------------------------------------------------
# Configuration – can be overridden via environment variables
# ----------------------------------------------------------------------
# Approximate power draw (Watts) for a typical classroom AC + lights.
DEFAULT_AC_POWER_W = int(os.getenv("MOCK_AC_POWER_W", "3500"))
DEFAULT_LIGHTS_POWER_W = int(os.getenv("MOCK_LIGHTS_POWER_W", "800"))
# Estimated savings per hour when everything is off (W).
SAVINGS_PER_HOUR_W = DEFAULT_AC_POWER_W + DEFAULT_LIGHTS_POWER_W

# Firestore collection for audit logs (optional – falls back to local file).
FIRESTORE_LOGS = os.getenv("MOCK_ENERGY_LOGS_FIRESTORE", "")

# ----------------------------------------------------------------------
# Helper: simple logger – writes JSON lines to a local file if Firestore not set.
# ----------------------------------------------------------------------
_LOG_FILE = os.path.join(os.path.dirname(__file__), "energy_log.jsonl")


def _log_entry(entry: Dict[str, Any]):
    """Persist a log entry.

    If the environment variable ``MOCK_ENERGY_LOGS_FIRESTORE`` points to a
    Firestore collection name, the function will attempt to write there via
    the Admin SDK.  Otherwise it appends a JSON line to ``energy_log.jsonl``.
    """
    if FIRESTORE_LOGS:
        try:
            import firebase_admin
            from firebase_admin import firestore
            if not firebase_admin._apps:
                firebase_admin.initialize_app()
            db = firestore.client()
            db.collection(FIRESTORE_LOGS).add(entry)
            return
        except Exception as exc:  # pragma: no cover – fallback on failure
            print(f"[MockEnergy] Firestore logging failed: {exc}")
    # Fallback to local file
    with open(_LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")

# ----------------------------------------------------------------------
# Core controller class
# ----------------------------------------------------------------------
class MockEnergyController:
    """In‑memory controller that tracks room power state.

    The controller does **not** interact with real hardware.  It simply
    records when a room is considered *active* (human present) or *idle*
    (no human).  When transitioning to *idle* it logs the estimated
    energy saved based on the elapsed idle time.
    """

    def __init__(self):
        # Mapping: room_id -> {"last_change": timestamp, "active": bool}
        self._room_state: Dict[str, Dict[str, Any]] = {}

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _record_savings(self, room_id: str, idle_seconds: float):
        """Calculate and log energy savings for a given idle period.
        """
        # Convert seconds to hours for the kWh calculation.
        hours = idle_seconds / 3600.0
        saved_wh = SAVINGS_PER_HOUR_W * hours  # Watt‑hours saved
        entry = {
            "room_id": room_id,
            "event": "energy_savings",
            "idle_seconds": round(idle_seconds, 2),
            "saved_watt_hours": round(saved_wh, 2),
            "timestamp": self._now().isoformat(),
        }
        _log_entry(entry)

    def update_room_status(self, room_id: str, human_present: bool):
        """Public API – call whenever occupancy metadata changes.

        Parameters
        ----------
        room_id : str
            Identifier of the room (matches the `roomId` used elsewhere).
        human_present : bool
            ``True`` if a person is detected, ``False`` otherwise.
        """
        now = self._now()
        state = self._room_state.get(room_id)

        if state is None:
            # First time we see this room – initialise state.
            self._room_state[room_id] = {
                "last_change": now,
                "active": human_present,
            }
            # If the room starts idle we don't have any savings yet.
            return {
                "room_id": room_id,
                "action": "initialized",
                "human_present": human_present,
            }

        # Detect a transition from active -> idle.
        if state["active"] and not human_present:
            idle_seconds = (now - state["last_change"]).total_seconds()
            # Log the savings for the *previous* active period.
            self._record_savings(room_id, idle_seconds)
            # Simulate turning off devices – we just log the action.
            entry = {
                "room_id": room_id,
                "event": "devices_off",
                "timestamp": now.isoformat(),
            }
            _log_entry(entry)
            # Update internal state.
            self._room_state[room_id] = {"last_change": now, "active": False}
            return {"room_id": room_id, "action": "devices_off"}

        # Transition from idle -> active (human arrives).
        if not state["active"] and human_present:
            # Log that we are turning devices back on.
            entry = {
                "room_id": room_id,
                "event": "devices_on",
                "timestamp": now.isoformat(),
            }
            _log_entry(entry)
            self._room_state[room_id] = {"last_change": now, "active": True}
            return {"room_id": room_id, "action": "devices_on"}

        # No state change – just update the timestamp for completeness.
        self._room_state[room_id]["last_change"] = now
        return {"room_id": room_id, "action": "no_change"}

# ----------------------------------------------------------------------
# Convenience singleton – importable as ``from energy_controller import controller``
# ----------------------------------------------------------------------
controller = MockEnergyController()

# ----------------------------------------------------------------------
# Example usage (executed only when run as a script, not when imported)
# ----------------------------------------------------------------------
if __name__ == "__main__":
    # Simulate a room that becomes empty after 10 seconds.
    import time
    room = "room_101"
    print(controller.update_room_status(room, True))   # human arrives
    time.sleep(10)
    print(controller.update_room_status(room, False))  # human leaves → devices off
    # Check the log file
    print("Log written to", _LOG_FILE)
```
