import os
import sys
from unittest import mock

# Edge modules import each other as top-level modules (see orchestrator.py).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The queue lives in memory for tests, so nothing lands next to the code.
os.environ["GHOST_QUEUE_DB"] = ":memory:"

# No test touches a camera, so CI does not need to install OpenCV.
try:
    import cv2  # noqa: F401
except ImportError:
    sys.modules["cv2"] = mock.MagicMock()
