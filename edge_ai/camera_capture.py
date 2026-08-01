# edge_ai/camera_capture.py
"""Camera capture module for Ghost Resource Buster.

- Accesses the default webcam (or a specified device index).
- Captures a frame every CAPTURE_INTERVAL seconds.
- Never writes image or video data to disk.
- Designed for low-power edge devices (Raspberry Pi, Jetson Nano).

CHANGE vs. the original version
-------------------------------
The original yielded only (timestamp, device_id, frame_shape) and dropped
the frame. That made real detection impossible downstream — the orchestrator
had nothing to analyse, so it fell back to `"occupied" if shape else "vacant"`,
which is always "occupied".

The frame is now yielded so human_presence.PresenceDetector can analyse it
in memory. The privacy guarantee is unchanged and now enforced by contract:
frames are never persisted and never leave the device; only a boolean and a
confidence score are transmitted.
"""

import os
import time
from typing import Generator, Tuple

import cv2

DEVICE_INDEX = int(os.getenv("DEVICE_INDEX_NUM", "0"))
CAPTURE_INTERVAL = float(os.getenv("GHOST_CAPTURE_INTERVAL", "2.0"))
DEVICE_ID = os.getenv("DEVICE_ID", "edge_cam_01")
FRAME_WIDTH = int(os.getenv("GHOST_FRAME_WIDTH", "320"))
FRAME_HEIGHT = int(os.getenv("GHOST_FRAME_HEIGHT", "240"))


def _init_camera() -> cv2.VideoCapture:
    """Initialize the webcam with minimal resource usage."""
    cap = cv2.VideoCapture(DEVICE_INDEX)
    # Low resolution keeps compute and power draw down on edge hardware.
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
    # Small buffer so we always analyse a fresh frame, not a stale one.
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    if not cap.isOpened():
        raise RuntimeError(f"Unable to open webcam (device index {DEVICE_INDEX})")
    return cap


def capture_frames() -> Generator[Tuple[float, str, "cv2.Mat"], None, None]:
    """Yield (timestamp, device_id, frame) every CAPTURE_INTERVAL seconds.

    The frame is passed in memory only. Callers must not persist it.
    """
    cap = _init_camera()
    consecutive_failures = 0
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                consecutive_failures += 1
                # Camera may have been unplugged — try a full re-init.
                if consecutive_failures >= 5:
                    print("[Camera] repeated read failures, reinitialising")
                    cap.release()
                    time.sleep(2.0)
                    try:
                        cap = _init_camera()
                        consecutive_failures = 0
                    except RuntimeError as exc:
                        print(f"[Camera] reinit failed: {exc}")
                time.sleep(CAPTURE_INTERVAL)
                continue

            consecutive_failures = 0
            yield (time.time(), DEVICE_ID, frame)
            time.sleep(CAPTURE_INTERVAL)
    finally:
        cap.release()


if __name__ == "__main__":
    gen = capture_frames()
    for _ in range(5):
        ts, dev, frame = next(gen)
        print(
            f"Captured at {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts))}, "
            f"device={dev}, shape={frame.shape}"
        )
