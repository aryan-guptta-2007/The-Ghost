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
5. Dead-letter instead of silent drop. Payloads that can no longer be
   delivered are moved to a `dead_letter` table rather than deleted, so
   failures are auditable.

QUEUE RULES
-----------
A reading that fails to send is retried until the backend would refuse it as
too old (see MAX_QUEUE_AGE_SECONDS), so a network outage costs nothing that
could still have arrived. A rejection (4xx) is dead-lettered at once, because
no retry can fix a bad signature or an unknown room.
"""

import os
import json
import time
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from camera_capture import capture_frames
from human_presence import PresenceDetector
from metadata_sender import BACKEND_URL, send_room_metadata

# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------
DEVICE_ID = os.getenv("DEVICE_ID", "edge_cam_01")
ROOM_ID = os.getenv("ROOM_ID", "room_unknown")
# Resend current state at least this often, so the backend can tell
# "genuinely vacant" apart from "edge device died". Five minutes keeps a
# room at ~290 Firestore writes a day (free tier: 20,000); the backend
# treats a device as silent after 12 minutes (GHOST_STALE_SECONDS).
# State changes are still sent immediately.
HEARTBEAT_SECONDS = int(os.getenv("GHOST_HEARTBEAT_SECONDS", "300"))
# The backend refuses readings older than 5 minutes, so stop just short of it.
MAX_QUEUE_AGE_SECONDS = int(os.getenv("GHOST_MAX_QUEUE_AGE_SECONDS", "280"))
# Longest wait between retries. Must stay well under MAX_QUEUE_AGE_SECONDS.
MAX_BACKOFF_SECONDS = 60

DB_PATH = os.getenv(
    "GHOST_QUEUE_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "pending_payloads.db"),
)


def config_problems(
    room_id: str = ROOM_ID,
    backend_url: str = BACKEND_URL,
    secret: Optional[str] = os.getenv("GHOST_HMAC_SECRET"),
) -> List[str]:
    """What stops this device from ever delivering a reading, if anything."""
    problems = []
    if room_id == "room_unknown":
        problems.append("ROOM_ID is not set")
    if not backend_url or "<your-app>" in backend_url:
        problems.append("GHOST_BACKEND_URL is not set to your deployed /api/occupancy URL")
    if not secret or secret.startswith("change-me"):
        problems.append("GHOST_HMAC_SECRET is not set")
    return problems


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


def _store_pending(payload: Dict[str, Any], delay: float = 0.0):
    conn.execute(
        "INSERT INTO pending (payload, next_retry_at) VALUES (?, ?)",
        (json.dumps(payload), time.time() + delay),
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
    backoff = min(2 ** attempts, MAX_BACKOFF_SECONDS)
    conn.execute(
        "UPDATE pending SET attempts = attempts + 1, last_error = ?, "
        "next_retry_at = ? WHERE id = ?",
        (error_msg, time.time() + backoff, row_id),
    )
    conn.commit()


def _dead_letter(payload_json: str, attempts: int, error_msg: str, row_id: Optional[int] = None):
    conn.execute(
        "INSERT INTO dead_letter (payload, attempts, last_error, failed_at) "
        "VALUES (?, ?, ?, ?)",
        (payload_json, attempts, error_msg, time.time()),
    )
    if row_id is not None:
        conn.execute("DELETE FROM pending WHERE id = ?", (row_id,))
    conn.commit()


# ----------------------------------------------------------------------
# Sending
# ----------------------------------------------------------------------
def _send_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return send_room_metadata(
            room_id=payload["room_id"],
            status=payload["status"],
            confidence=payload["confidence"],
            timestamp=payload["timestamp"],
        )
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def _age_seconds(payload: Dict[str, Any]) -> float:
    return time.time() - datetime.fromisoformat(payload["timestamp"]).timestamp()


def _flush_pending():
    """Retry queued payloads whose time has come, oldest first.

    Stops at the first failed send: the network is probably still down, and
    each attempt can block capture for the whole request timeout.
    """
    for row_id, payload_json, attempts in _due_pending():
        payload = json.loads(payload_json)
        if _age_seconds(payload) > MAX_QUEUE_AGE_SECONDS:
            _dead_letter(payload_json, attempts, "too old for the backend to accept", row_id)
            print(f"[Orchestrator] payload {row_id} expired, moved to dead_letter")
            continue

        result = _send_payload(payload)
        if result.get("success"):
            _delete_pending(row_id)
            print(f"[Orchestrator] pending payload {row_id} delivered")
        elif result.get("permanent"):
            _dead_letter(payload_json, attempts + 1, result.get("error"), row_id)
            print(f"[Orchestrator] payload {row_id} rejected: {result.get('error')}")
        else:
            _schedule_retry(row_id, attempts, result.get("error") or "send failed")
            break


def _deliver(payload: Dict[str, Any]):
    """Send a new reading now, queueing it if that fails for a fixable reason."""
    result = _send_payload(payload)
    if result.get("success"):
        return
    print(f"[Orchestrator] send failed: {result.get('error')}")
    if result.get("permanent"):
        _dead_letter(json.dumps(payload), 1, result.get("error"))
    else:
        # Not due yet: the flush that follows must not repeat this attempt.
        _store_pending(payload, delay=1.0)


def _should_send(verdict: Dict[str, Any], timestamp: float, last_sent_at: float) -> bool:
    """Send on a state change and on the heartbeat, but never on a guess.

    The detector starts out "occupied" so it cannot accuse anyone without
    evidence. Reporting that guess is just as wrong: after a reboot it would
    clear an open warning for a room nobody is in.
    """
    if not verdict["settled"]:
        return False
    return verdict["changed"] or (timestamp - last_sent_at) >= HEARTBEAT_SECONDS


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def run():
    problems = config_problems()
    if problems:
        raise SystemExit("[Orchestrator] cannot start: " + "; ".join(problems))

    detector = PresenceDetector()
    print(f"[Orchestrator] room={ROOM_ID} device={DEVICE_ID} "
          f"backend={detector.backend_name}")

    last_sent_at = 0.0

    try:
        for timestamp, _device_id, frame in capture_frames():
            verdict = detector.update(frame)
            # `frame` is deliberately not stored or forwarded anywhere.

            if _should_send(verdict, timestamp, last_sent_at):
                _deliver({
                    "room_id": ROOM_ID,
                    "status": "occupied" if verdict["occupied"] else "vacant",
                    "confidence": verdict["confidence"],
                    "timestamp": _iso(timestamp),
                })
                last_sent_at = timestamp

            _flush_pending()
    except KeyboardInterrupt:
        print("[Orchestrator] shutting down")
    finally:
        detector.close()
        conn.close()


if __name__ == "__main__":
    run()
