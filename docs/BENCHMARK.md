# Detection Benchmark

Measured on a laptop webcam, indoor lighting, seated at a desk.

| Condition | Confidence |
|-----------|-----------|
| Person present, seated, still | 0.78 (stable) |
| Room empty | 0.00 |

Detection latency on leaving: ~20 seconds (7-of-10 debounce at 2s intervals).
False vacancy while present: none observed over 60 seconds seated.

## Tuning notes

Three changes were needed to get a usable signal:

1. **Upper-body landmarks only.** Averaging all 33 MediaPipe landmarks
   penalised seated people whose legs are outside the frame — the normal
   case for a desk-mounted camera.
2. **`static_image_mode=True`.** With tracking enabled, MediaPipe kept
   reporting landmarks for a person who had already left, pushing "absent"
   confidence as high as 0.43 and overlapping the "present" range.
3. **Fraction of clearly-visible landmarks** instead of mean visibility.
   A mean is dragged down by a few occluded points even when the person is
   plainly there.

Before these changes: present 0.29–0.44, absent 0.09–0.43 — overlapping
ranges, no usable threshold.
After: present 0.78, absent 0.00.
