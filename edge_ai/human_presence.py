# edge_ai/human_presence.py
"""Human presence detection for Ghost Resource Buster.

WHY THIS FILE EXISTS
--------------------
The original repository referenced a `human_presence` generator in
orchestrator.py's docstring, but no such module existed. The orchestrator
computed:

    status = "occupied" if shape else "vacant"

`shape` is a frame's dimension tuple, which is *always* truthy — so every
room was reported "occupied" forever and no ghost booking could ever be
detected. This module supplies the real decision.

DESIGN
------
1. Detection runs entirely on the edge device. Only a boolean + confidence
   leaves the room. No image or video is stored or transmitted.
2. Two backends, selected automatically:
     - MediaPipe pose/person detection (preferred, accurate)
     - OpenCV HOG people detector (fallback, no extra model download)
3. TEMPORAL DEBOUNCE is the important part. A single frame is never enough
   to accuse a real occupant of being a ghost — a person looking down,
   sitting behind a monitor, or momentarily out of frame will produce a
   false negative. We require N vacant readings out of the last M before
   flipping the room's reported state.
"""

import os
import time
from collections import deque
from typing import Optional, Tuple

import numpy as np

# ----------------------------------------------------------------------
# Tunables — override via environment variables
# ----------------------------------------------------------------------
# Minimum per-frame confidence for a detection to count as a person.
MIN_CONFIDENCE = float(os.getenv("GHOST_MIN_CONFIDENCE", "0.5"))
# Sliding window of recent frames used for the debounce decision.
WINDOW_SIZE = int(os.getenv("GHOST_WINDOW_SIZE", "10"))
# How many frames in the window must agree before we flip state.
FLIP_THRESHOLD = int(os.getenv("GHOST_FLIP_THRESHOLD", "7"))


class _MediaPipeBackend:
    """Preferred backend. Accurate, runs well on Pi 4 / Jetson Nano."""

    name = "mediapipe"

    def __init__(self):
        import mediapipe as mp

        self._pose = mp.solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=0,          # lightest model for edge devices
            min_detection_confidence=MIN_CONFIDENCE,
        )

    def detect(self, frame) -> Tuple[bool, float]:
        import cv2

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        result = self._pose.process(rgb)
        if not result.pose_landmarks:
            return False, 0.0
        # Mean visibility of detected landmarks as a confidence proxy.
        visibilities = [lm.visibility for lm in result.pose_landmarks.landmark]
        confidence = float(np.mean(visibilities)) if visibilities else 0.0
        return confidence >= MIN_CONFIDENCE, confidence

    def close(self):
        self._pose.close()


class _HogBackend:
    """Fallback backend. Ships with OpenCV, no model download required.

    Less accurate than MediaPipe — acceptable for a demo, not for
    production enforcement.
    """

    name = "opencv-hog"

    def __init__(self):
        import cv2

        self._hog = cv2.HOGDescriptor()
        self._hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def detect(self, frame) -> Tuple[bool, float]:
        rects, weights = self._hog.detectMultiScale(
            frame, winStride=(8, 8), padding=(8, 8), scale=1.05
        )
        if len(rects) == 0:
            return False, 0.0
        # HOG weights are SVM margins; squash into a rough 0..1 confidence.
        best = float(np.max(weights))
        confidence = min(1.0, max(0.0, best / 2.0))
        return confidence >= MIN_CONFIDENCE, confidence

    def close(self):
        pass


def _build_backend():
    """Pick the best available backend at runtime."""
    try:
        return _MediaPipeBackend()
    except Exception as exc:
        print(f"[HumanPresence] MediaPipe unavailable ({exc}); using OpenCV HOG.")
        return _HogBackend()


class PresenceDetector:
    """Stateful detector with temporal debounce.

    Usage
    -----
        detector = PresenceDetector()
        state = detector.update(frame)
        if state is not None:
            # state.changed is True only when the room flipped
            ...
    """

    def __init__(self, window_size: int = WINDOW_SIZE, threshold: int = FLIP_THRESHOLD):
        if threshold > window_size:
            raise ValueError("FLIP_THRESHOLD cannot exceed WINDOW_SIZE")
        self._backend = _build_backend()
        self._window = deque(maxlen=window_size)
        self._threshold = threshold
        # Start optimistic: assume occupied, so we never falsely accuse
        # someone before we have collected enough evidence.
        self._state: bool = True
        self._last_flip: float = time.time()

    @property
    def backend_name(self) -> str:
        return self._backend.name

    @property
    def occupied(self) -> bool:
        return self._state

    def update(self, frame) -> dict:
        """Feed one frame. Returns the current debounced verdict.

        Returns a dict with:
            occupied   : bool  — debounced room state
            confidence : float — mean confidence across the window
            changed    : bool  — True only on the frame the state flipped
            raw        : bool  — this single frame's unfiltered detection
            samples    : int   — how many frames in the window so far
        """
        raw, confidence = self._backend.detect(frame)
        self._window.append((raw, confidence))

        occupied_votes = sum(1 for r, _ in self._window if r)
        vacant_votes = len(self._window) - occupied_votes

        changed = False
        # Only flip once the window holds enough agreeing evidence.
        if len(self._window) >= self._threshold:
            if self._state and vacant_votes >= self._threshold:
                self._state = False
                changed = True
                self._last_flip = time.time()
            elif not self._state and occupied_votes >= self._threshold:
                self._state = True
                changed = True
                self._last_flip = time.time()

        mean_conf = (
            float(np.mean([c for _, c in self._window])) if self._window else 0.0
        )

        return {
            "occupied": self._state,
            "confidence": round(mean_conf, 3),
            "changed": changed,
            "raw": raw,
            "samples": len(self._window),
        }

    def close(self):
        self._backend.close()


if __name__ == "__main__":
    # Smoke test against the webcam. Prints the debounced verdict live.
    import cv2

    cap = cv2.VideoCapture(int(os.getenv("DEVICE_INDEX", "0")))
    detector = PresenceDetector()
    print(f"[HumanPresence] backend = {detector.backend_name}")
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.5)
                continue
            verdict = detector.update(frame)
            flag = " <-- STATE CHANGED" if verdict["changed"] else ""
            print(
                f"occupied={verdict['occupied']} "
                f"conf={verdict['confidence']:.2f} "
                f"samples={verdict['samples']}{flag}"
            )
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        detector.close()
