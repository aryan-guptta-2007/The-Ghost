# edge_ai/metadata_sender.py
"""Utility to send occupancy metadata to the backend with HMAC authentication.

The edge device holds a secret key (environment variable GHOST_HMAC_SECRET).
Each payload includes:
  - room_id
  - status ("occupied" / "vacant")
  - confidence (float)
  - timestamp (ISO-8601 string, UTC)
  - signature (hex HMAC-SHA256 over the canonical JSON of the fields above)

The signature is verified in functions/lib/hmac.js before any processing.
"""

import os
import json
import hmac
import hashlib

import requests

# Backend endpoint – must match the deployed receiveOccupancy URL.
BACKEND_URL = os.getenv(
    "GHOST_BACKEND_URL",
    "https://<your-project>.cloudfunctions.net/receiveOccupancy",
)


def _secret() -> bytes:
    # Read lazily so the module can be imported (and tested) without it.
    secret = os.getenv("GHOST_HMAC_SECRET")
    if not secret:
        raise RuntimeError("GHOST_HMAC_SECRET environment variable not set on edge device")
    return secret.encode("utf-8")


def _normalise_confidence(value: float):
    """Make the number serialise the same way in Python and JavaScript.

    Python writes 0.0 as "0.0", JavaScript writes it as "0". A vacant room
    reports exactly 0.0, so without this every vacant reading failed the
    backend's signature check.
    """
    value = round(float(value), 3)
    return int(value) if value.is_integer() else value


def _canonical_json(payload: dict) -> str:
    """Deterministic JSON for signing: sorted keys, no whitespace, raw UTF-8.

    Must match canonicalJson() in functions/lib/hmac.js byte for byte.
    """
    return json.dumps(payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def _sign_payload(payload: dict, secret: bytes = None) -> str:
    """Create an HMAC-SHA256 signature (hex string)."""
    message = _canonical_json(payload).encode("utf-8")
    return hmac.new(secret or _secret(), message, hashlib.sha256).hexdigest()


def build_payload(room_id: str, status: str, confidence: float, timestamp: str, secret: bytes = None) -> dict:
    payload = {
        "room_id": room_id,
        "status": status,
        "confidence": _normalise_confidence(confidence),
        "timestamp": timestamp,  # ISO-8601 UTC string
    }
    payload["signature"] = _sign_payload(payload, secret)
    return payload


def send_room_metadata(room_id: str, status: str, confidence: float, timestamp: str) -> dict:
    """POST the metadata to the backend with a signature.
    Returns a dict with ``success`` and either ``response`` or ``error``.
    """
    payload = build_payload(room_id, status, confidence, timestamp)
    try:
        resp = requests.post(
            BACKEND_URL,
            json=payload,
            timeout=int(os.getenv("GHOST_TIMEOUT", "10")),
            verify=True,
        )
        # 409 means the backend already has this exact payload (a retry of
        # something that did arrive), so it counts as delivered.
        if resp.status_code == 409:
            return {"success": True, "response": {"duplicate": True}}
        resp.raise_for_status()
        return {"success": True, "response": resp.json()}
    except Exception as exc:
        # Caller will handle retry / queueing
        return {"success": False, "error": str(exc)}
