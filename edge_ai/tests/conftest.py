import os
import sys

# Edge modules import each other as top-level modules (see orchestrator.py).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
