"""The edge signer and the backend verifier must agree byte for byte."""

from metadata_sender import _canonical_json, build_payload

# Same vector as backend/test/unit.test.js.
VECTOR = "527f9fcaff60db95667dd447ae33fd1b11c6c6fc05e8b95ef6dc6f6d85d19964"


def test_vacant_reading_matches_backend_vector():
    # confidence 0.0 is what a vacant room reports. Python prints it as
    # "0.0" and JavaScript as "0", which used to break every vacant reading.
    payload = build_payload(
        "room_101", "vacant", 0.0, "2026-01-01T00:00:00+00:00", secret=b"test-secret"
    )
    assert payload["confidence"] == 0
    assert payload["signature"] == VECTOR


def test_canonical_json_is_compact_sorted_utf8():
    assert _canonical_json({"b": 1, "a": "é"}) == '{"a":"é","b":1}'


def test_fractional_confidence_is_kept():
    payload = build_payload("r", "occupied", 0.78123, "t", secret=b"s")
    assert payload["confidence"] == 0.781
