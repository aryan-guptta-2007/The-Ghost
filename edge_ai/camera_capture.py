# edge_ai/camera_capture.py
"""Camera capture module for Ghost Resource Buster.

- Accesses the default webcam (or a specified device index).
- Captures a single frame every 2 seconds.
- Does **not** store any image or video data on disk.
- Designed for low‑power edge devices (e.g., Raspberry Pi, Jetson Nano).
- Provides a simple generator `capture_frames()` that yields metadata
  (timestamp, device_id, frame_shape) which can be fed directly to the
  edge‑AI detector.
"""

import cv2
import time
from typing import Generator, Tuple

# Configuration – can be moved to a settings file later
DEVICE_INDEX = 0  # default webcam; change if multiple cameras are present
CAPTURE_INTERVAL = 2.0  # seconds between captures
DEVICE_ID = "edge_cam_01"  # unique identifier for this edge device


def _init_camera() -> cv2.VideoCapture:
    """Initialize the webcam with minimal resource usage.

    Returns
    -------
    cv2.VideoCapture
        The opened video capture object.
    """
    cap = cv2.VideoCapture(DEVICE_INDEX)
    # Reduce resolution to lower compute & power consumption (e.g., 320x240)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 320)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 240)
    # Limit FPS to the capture interval to avoid unnecessary reads
    cap.set(cv2.CAP_PROP_FPS, 1 / CAPTURE_INTERVAL)
    if not cap.isOpened():
        raise RuntimeError("Unable to open webcam (device index %d)" % DEVICE_INDEX)
    return cap


def capture_frames() -> Generator[Tuple[float, str, Tuple[int, int, int]], None, None]:
    """Yield metadata for a frame captured every ``CAPTURE_INTERVAL`` seconds.

    The actual image data is **not** returned or stored – only the shape and a
    timestamp are emitted. Downstream modules (e.g., the MediaPipe/TFLite
    detector) can request the raw frame via the generator if needed, but the
    default behaviour respects the privacy‑first requirement.
    """
    cap = _init_camera()
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                # If a frame cannot be read, wait a bit and retry
                time.sleep(CAPTURE_INTERVAL)
                continue
            timestamp = time.time()
            # Frame shape: (height, width, channels)
            shape = frame.shape
            # Yield only metadata; the frame variable will be garbage‑collected
            yield (timestamp, DEVICE_ID, shape)
            # Sleep for the remainder of the interval
            time.sleep(CAPTURE_INTERVAL)
    finally:
        # Ensure the camera is released even if the generator is stopped
        cap.release()


if __name__ == "__main__":
    # Simple demo: print metadata for 5 captures
    gen = capture_frames()
    for _ in range(5):
        meta = next(gen)
        print(f"Captured at {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(meta[0]))}, "
              f"device={meta[1]}, shape={meta[2]}")
