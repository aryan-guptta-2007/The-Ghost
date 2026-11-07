"""Tests for new capabilities: low-light CLAHE and headcount tracking."""

import numpy as np
import pytest

import human_presence
from metadata_sender import build_payload


class MultiPersonBackend:
    name = "multiperson-mock"

    def __init__(self, sequence):
        self._seq = iter(sequence)

    def detect(self, _frame):
        present, conf, count = next(self._seq)
        return present, conf, count

    def close(self):
        pass


def test_headcount_tracked_in_presence_detector(monkeypatch):
    sequence = [(True, 0.8, 4)] * 10
    monkeypatch.setattr(
        human_presence, "_build_backend", lambda: MultiPersonBackend(sequence)
    )
    detector = human_presence.PresenceDetector(window_size=10, threshold=7)
    for _ in range(9):
        detector.update(None)
    verdict = detector.update(None)
    assert verdict["occupied"] is True
    assert verdict["headcount"] == 4
    assert verdict["settled"] is True


def test_headcount_in_payload_signing():
    payload = build_payload(
        "room_101",
        "occupied",
        0.8,
        "2026-01-01T00:00:00+00:00",
        secret=b"test-secret",
        headcount=3,
    )
    assert payload["headcount"] == 3
    assert "signature" in payload
    assert len(payload["signature"]) == 64


def test_low_light_enhancement_on_dummy_frame():
    # 100x100 black/gray dummy image
    frame = np.full((100, 100, 3), 30, dtype=np.uint8)
    enhanced = human_presence.enhance_low_light(frame)
    assert enhanced is not None
    if hasattr(enhanced, "shape"):
        assert len(enhanced.shape) == 3
