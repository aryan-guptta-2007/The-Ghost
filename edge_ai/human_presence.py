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
4. LOW-LIGHT ROBUSTNESS: adaptive CLAHE histogram equalization prevents
   false vacancy in presentation rooms where lights are dimmed for projectors.
5. HEADCOUNT ESTIMATION: detects single occupants in large auditoriums to
   flag under-utilized space.
"""

import os
import time
from collections import deque
from typing import Optional, Tuple

import numpy as np

# ----------------------------------------------------------------------
# Tunables — override via environment variables
# ----------------------------------------------------------------------
# Minimum per-frame confidence for a HOG detection to count as a person.
# MediaPipe ignores this: its landmarks are themselves the detection, and
# confidence only describes how much of the person it could see.
MIN_CONFIDENCE = float(os.getenv("GHOST_MIN_CONFIDENCE", "0.3"))
# Sliding window of recent frames used for the debounce decision.
WINDOW_SIZE = int(os.getenv("GHOST_WINDOW_SIZE", "10"))
# How many frames in the window must agree before we flip state.
FLIP_THRESHOLD = int(os.getenv("GHOST_FLIP_THRESHOLD", "7"))
# Low-light enhancement (adaptive histogram equalization for dim rooms / projectors)
ENABLE_LOW_LIGHT_ENHANCE = os.getenv("GHOST_LOW_LIGHT_ENHANCE", "true").lower() == "true"


def enhance_low_light(frame):
    """Enhance contrast for dim presentation/projector rooms using CLAHE."""
    if frame is None or not ENABLE_LOW_LIGHT_ENHANCE:
        return frame
    try:
        import cv2

        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l_enhanced = clahe.apply(l)
        enhanced_lab = cv2.merge((l_enhanced, a, b))
        return cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2BGR)
    except Exception:
        return frame


class _MediaPipeBackend:
    """Preferred backend. Accurate, runs well on Pi 4 / Jetson Nano."""

    name = "mediapipe"

    def __init__(self):
        import mediapipe as mp

        # static_image_mode=True runs a fresh detection on every frame.
        # With tracking enabled, MediaPipe keeps reporting landmarks for a
        # person who has already left, which made present and absent
        # confidence ranges overlap and the signal unusable.
        self._pose = mp.solutions.pose.Pose(
            static_image_mode=True,
            model_complexity=1,
            min_detection_confidence=0.5,
        )

    def detect(self, frame) -> Tuple[bool, float, int]:
        import cv2

        processed_frame = enhance_low_light(frame)
        rgb = cv2.cvtColor(processed_frame, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        result = self._pose.process(rgb)
        if not result.pose_landmarks:
            return False, 0.0, 0
        # Upper-body landmarks only: nose, eyes, ears, shoulders, elbows.
        # Averaging all 33 landmarks penalises seated people whose legs are
        # not visible to a desk-mounted webcam, which is the normal case.
        UPPER_BODY = [0, 2, 5, 7, 8, 11, 12, 13, 14]
        landmarks = result.pose_landmarks.landmark
        visibilities = [landmarks[i].visibility for i in UPPER_BODY]
        # Fraction of upper-body landmarks clearly visible, rather than a
        # mean. A mean is dragged down by a few occluded points even when
        # the person is plainly there.
        clear = sum(1 for v in visibilities if v > 0.5)
        confidence = clear / len(visibilities) if visibilities else 0.0
        # MediaPipe returning landmarks at all is itself strong evidence,
        # so presence is the detection, and confidence is the quality of it.
        return True, confidence, 1

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

    def detect(self, frame) -> Tuple[bool, float, int]:
        processed_frame = enhance_low_light(frame)
        rects, weights = self._hog.detectMultiScale(
            processed_frame, winStride=(8, 8), padding=(8, 8), scale=1.05
        )
        if len(rects) == 0:
            return False, 0.0, 0
        # HOG weights are SVM margins; squash into a rough 0..1 confidence.
        best = float(np.max(weights))
        confidence = min(1.0, max(0.0, best / 2.0))
        headcount = len(rects)
        return confidence >= MIN_CONFIDENCE, confidence, headcount

    def close(self):
        pass


def _build_backend():
    """Pick the best available backend at runtime."""
    try:
        return _MediaPipeBackend()
    except Exception as exc:
        print(f"[HumanPresence] MediaPipe unavailable ({exc}); using OpenCV HOG.")
    try:
        return _HogBackend()
    except AttributeError as exc:
        raise RuntimeError(
            "No detection backend available. Install the pinned versions: "
            "pip install -r requirements.txt (OpenCV 5 has no HOGDescriptor)"
        ) from exc


class PresenceDetector:
    """Stateful detector with temporal debounce and headcount tracking.

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
            headcount  : int   — estimated occupant count
            changed    : bool  — True only on the frame the state flipped
            raw        : bool  — this single frame's unfiltered detection
            samples    : int   — how many frames in the window so far
            settled    : bool  — enough frames seen for `occupied` to be
                                 evidence rather than the starting guess
        """
        backend_result = self._backend.detect(frame)
        if len(backend_result) == 3:
            raw, confidence, count = backend_result
        else:
            raw, confidence = backend_result
            count = 1 if raw else 0

        self._window.append((raw, confidence, count))

        occupied_votes = sum(1 for item in self._window if item[0])
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
            float(np.mean([item[1] for item in self._window])) if self._window else 0.0
        )
        current_headcount = (
            max([item[2] for item in self._window]) if (self._state and self._window) else 0
        )

        return {
            "occupied": self._state,
            "confidence": round(mean_conf, 3),
            "headcount": current_headcount,
            "changed": changed,
            "raw": raw,
            "samples": len(self._window),
            "settled": len(self._window) >= self._threshold,
        }

    def close(self):
        self._backend.close()


if __name__ == "__main__":
    # Smoke test against the webcam. Prints the debounced verdict live.
    import cv2

    cap = cv2.VideoCapture(int(os.getenv("DEVICE_INDEX_NUM", "0")))
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
                f"headcount={verdict.get('headcount', 0)} "
                f"samples={verdict['samples']}{flag}"
            )
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        detector.close()
