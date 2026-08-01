# edge_ai/orchestrator.py
"""Orchestrator for the Ghost Resource Buster edge device.

Pipeline:
    camera_capture -> human_presence (debounced) -> metadata_sender -> backend

FIXES vs. the original version
------------------------------
1. Real detection. The original set
       status = "occupied" if shape else "vacant"
   where `shape` is always truthy, so every room reported "occupied"
   forever and no ghost could ever be found. It now uses PresenceDetector.
2. Event-driven sending. The original POSTed on every single frame
   (every 2s, forever) — needless cost and battery drain. It now sends on
   state change plus a periodic heartbeat, so the backend can also
   distinguish "vacant" from "device offline".
3. Non-blocking retries. The original called time.sleep(backoff) inside
   the capture loop, freezing detection for up to 60s. Retries are now
   scheduled by wall-clock time and never block capture.
4. ISO-8601 timestamps. The original sent a raw float despite the
   metadata_sender docstring promising ISO-8601 UTC, and the backend
   called .toDate() on it.
5. Dead-letter instead of silent drop. Payloads exceeding max attempts are
   moved to a `dead_letter` table rather than deleted, so failures are
   auditable.
"""

import os
import json
import time
import sqlite3
from datetime import datetime, timezone
from typing import Dict, Any

from camera_capture import capture_frames
from human_presence import PresenceDetector
from metadata_sender import send_room_metadata

# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------
DEVICE_ID = os.getenv("DEVICE_ID", "edge_cam_01")
ROOM_ID = os.getenv("ROOM_ID", "room_unknown")
# Resend current state at least this often, so the backend can tell
# "genuinely vacant" apart from "edge device died".
HEARTBEAT_SECONDS = int(os.getenv("GHOST_HEARTBEAT_SECONDS", "60"))
MAX_ATTEMPTS = int(os.getenv("GHOST_MAX_ATTEMPTS", "5"))

DB_PATH = os.path.join(os.path.dirname(__file__), "pending_payloads.db")


# ----------------------------------------------------------------------
# Local persistence for pending payloads
# ----------------------------------------------------------------------
def _init_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS pending (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            payload TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at REAL NOT NULL DEFAULT 0,
            last_error TEXT
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS dead_letter (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            payload TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            last_error TEXT,
            failed_at REAL NOT NULL
        )"""
    )
    conn.commit()
    return conn


conn = _init_db()


def _store_pending(payload: Dict[str, Any]):
    conn.execute(
        "INSERT INTO pending (payload, next_retry_at) VALUES (?, ?)",
        (json.dumps(payload), time.time()),
    )
    conn.commit()


def _due_pending(limit: int = 10):
    cur = conn.execute(
        "SELECT id, payload, attempts FROM pending "
        "WHERE next_retry_at <= ? ORDER BY id ASC LIMIT ?",
        (time.time(), limit),
    )
    return cur.fetchall()


def _delete_pending(row_id: int):
    conn.execute("DELETE FROM pending WHERE id = ?", (row_id,))
    conn.commit()


def _schedule_retry(row_id: int, attempts: int, error_msg: str):
    backoff = min(2 ** attempts, 300)  # cap at 5 minutes
    conn.execute(
        "UPDATE pending SET attempts = attempts + 1, last_error = ?, "
        "next_retry_at = ? WHERE id = ?",
        (error_msg, time.time() + backoff, row_id),
    )
    conn.commit()


def _dead_letter(row_id: int, payload_json: str, attempts: int, error_msg: str):
    conn.execute(
        "INSERT INTO dead_letter (payload, attempts, last_error, failed_at) "
        "VALUES (?, ?, ?, ?)",
        (payload_json, attempts, error_msg, time.time()),
    )
    conn.execute("DELETE FROM pending WHERE id = ?", (row_id,))
    conn.commit()


# ----------------------------------------------------------------------
# Sending
# ----------------------------------------------------------------------
def _send_payload(payload: Dict[str, Any]) -> bool:
    try:
        result = send_room_metadata(
            room_id=payload["room_id"],
            status=payload["status"],
            confidence=payload["confidence"],
            timestamp=payload["timestamp"],
        )
        return bool(result.get("success"))
    except Exception as exc:
        print(f"[Orchestrator] send error: {exc}")
        return False


def _flush_pending():
    """Non-blocking: only touches payloads whose retry time has arrived."""
    for row_id, payload_json, attempts in _due_pending():
        if _send_payload(json.loads(payload_json)):
            _delete_pending(row_id)
            print(f"[Orchestrator] pending payload {row_id} delivered")
        elif attempts + 1 >= MAX_ATTEMPTS:
            _dead_letter(row_id, payload_json, attempts + 1, "max attempts exceeded")
            print(f"[Orchestrator] payload {row_id} moved to dead_letter")
        else:
            _schedule_retry(row_id, attempts, "send failed")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def run():
    detector = PresenceDetector()
    print(f"[Orchestrator] room={ROOM_ID} device={DEVICE_ID} "
          f"backend={detector.backend_name}")

    last_sent_at = 0.0

    try:
        for timestamp, _device_id, frame in capture_frames():
            verdict = detector.update(frame)
            # `frame` is deliberately not stored or forwarded anywhere.

            due_heartbeat = (timestamp - last_sent_at) >= HEARTBEAT_SECONDS
            if not (verdict["changed"] or due_heartbeat):
                _flush_pending()
                continue

            payload = {
                "room_id": ROOM_ID,
                "status": "occupied" if verdict["occupied"] else "vacant",
                "confidence": verdict["confidence"],
                "timestamp": _iso(timestamp),
            }

            if _send_payload(payload):
                last_sent_at = timestamp
            else:
                _store_pending(payload)
                last_sent_at = timestamp

            _flush_pending()
    except KeyboardInterrupt:
        print("[Orchestrator] shutting down")
    finally:
        detector.close()
        conn.close()


if __name__ == "__main__":
    run()
