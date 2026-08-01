# edge_ai/metadata_sender.py
"""Utility to send occupancy metadata to the backend with HMAC authentication.

The edge device holds a secret key (environment variable GHOST_HMAC_SECRET).
Each payload includes:
  - room_id
  - status ("occupied" / "vacant")
  - confidence (float)
  - timestamp (ISO‑8601 string, UTC)
  - signature (hex HMAC‑SHA256 over the canonical JSON string + timestamp)

The signature is verified in the Cloud Function before any processing.
"""

import os
import json
import hmac
import hashlib
import requests
from datetime import datetime, timezone

# Backend endpoint – must match the HTTPS‑callable URL you expose.
BACKEND_URL = os.getenv(
    "GHOST_BACKEND_URL",
    "https://<your-project>.cloudfunctions.net/receiveOccupancy",
)

# Secret key for HMAC – must be the same on the device and in the Cloud Function config.
HMAC_SECRET = os.getenv("GHOST_HMAC_SECRET")
if not HMAC_SECRET:
    raise RuntimeError("GHOST_HMAC_SECRET environment variable not set on edge device")


def _canonical_json(payload: dict) -> str:
    """Return a deterministic JSON string for signing (sorted keys, no whitespace)."""
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _sign_payload(payload: dict) -> str:
    """Create an HMAC‑SHA256 signature (hex string)."""
    message = _canonical_json(payload).encode("utf-8")
    secret = HMAC_SECRET.encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def send_room_metadata(room_id: str, status: str, confidence: float, timestamp: str) -> dict:
    """POST the metadata to the backend with a signature.
    Returns a dict with ``success`` and either ``response`` or ``error``.
    """
    payload = {
        "room_id": room_id,
        "status": status,
        "confidence": confidence,
        "timestamp": timestamp,  # ISO‑8601 UTC string
    }
    payload["signature"] = _sign_payload(payload)

    try:
        resp = requests.post(
            BACKEND_URL,
            json=payload,
            timeout=int(os.getenv("GHOST_TIMEOUT", "10")),
            verify=True,
        )
        resp.raise_for_status()
        return {"success": True, "response": resp.json()}
    except Exception as exc:
        # Caller will handle retry / queueing
        return {"success": False, "error": str(exc)}
