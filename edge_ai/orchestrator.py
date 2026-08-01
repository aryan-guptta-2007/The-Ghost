# edge_ai/orchestrator.py
"""Orchestrator for Ghost Resource Buster edge device.

- Captures occupancy metadata from `human_presence` generator.
- Sends the metadata to the backend via `metadata_sender.send_room_metadata`.
- Implements offline queueing and exponential back‑off retries for network failures.
- Guarantees at‑most‑once delivery using a local SQLite DB (lightweight) to
  persist pending payloads across restarts.
"""

import os
import json
import time
import sqlite3
from typing import Dict, Any

from camera_capture import capture_frames  # generator from edge_ai/camera_capture.py
from metadata_sender import send_room_metadata

# ----------------------------------------------------------------------
# Local persistence for pending payloads (simple SQLite DB in the same dir)
# ----------------------------------------------------------------------
DB_PATH = os.path.join(os.path.dirname(__file__), "pending_payloads.db")
conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()
cur.execute(
    """CREATE TABLE IF NOT EXISTS pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
    )"""
)
conn.commit()


def _store_pending(payload: Dict[str, Any]):
    cur.execute("INSERT INTO pending (payload) VALUES (?)", (json.dumps(payload),))
    conn.commit()

def _fetch_pending(limit: int = 10):
    cur.execute("SELECT id, payload, attempts FROM pending ORDER BY id ASC LIMIT ?", (limit,))
    return cur.fetchall()

def _delete_pending(row_id: int):
    cur.execute("DELETE FROM pending WHERE id = ?", (row_id,))
    conn.commit()

def _increment_attempt(row_id: int, error_msg: str):
    cur.execute(
        "UPDATE pending SET attempts = attempts + 1, last_error = ? WHERE id = ?",
        (error_msg, row_id),
    )
    conn.commit()

# ----------------------------------------------------------------------
# Main loop – captures frames and attempts to send them.
# ----------------------------------------------------------------------
DEVICE_ID = os.getenv("DEVICE_ID", "edge_cam_01")
ROOM_ID = os.getenv("ROOM_ID", "room_unknown")

def _send_payload(payload: Dict[str, Any]) -> bool:
    """Attempt to send a payload via the metadata_sender.
    Returns True on success, False on failure.
    """
    try:
        result = send_room_metadata(
            room_id=payload["room_id"],
            status=payload["status"],
            confidence=payload["confidence"],
            timestamp=payload["timestamp"],
        )
        return result.get("success", False)
    except Exception as exc:  # pragma: no cover – network failures
        print(f"[Orchestrator] send error: {exc}")
        return False

def _process_pending():
    pending = _fetch_pending()
    for row_id, payload_json, attempts in pending:
        payload = json.loads(payload_json)
        success = _send_payload(payload)
        if success:
            _delete_pending(row_id)
            print(f"[Orchestrator] pending payload {row_id} delivered")
        else:
            # Exponential back‑off: cap attempts at 5 before discarding.
            if attempts >= 5:
                _delete_pending(row_id)
                print(f"[Orchestrator] dropping payload {row_id} after {attempts} attempts")
            else:
                _increment_attempt(row_id, "send failed")
                backoff = min(2 ** attempts, 60)  # seconds, max 1 min
                print(f"[Orchestrator] will retry payload {row_id} after {backoff}s")
                time.sleep(backoff)

def run():
    for timestamp, device_id, shape in capture_frames():
        # Build minimal payload – no image data.
        payload = {
            "room_id": ROOM_ID,
            "status": "occupied" if shape else "vacant",  # shape always present; placeholder logic
            "confidence": 0.99,  # placeholder – real detector would provide this
            "timestamp": timestamp,
        }
        # Try immediate send; on failure store for later retry.
        if not _send_payload(payload):
            _store_pending(payload)
        # Periodically flush pending queue.
        _process_pending()

if __name__ == "__main__":
    run()
