# Ghost Resource Buster

**Privacy-first occupancy enforcement for shared rooms.** Detects booked-but-empty
rooms, gives the owner a chance to confirm, then releases the room and cuts the
power. No image or video ever leaves the room.

> **Status: working prototype (~45% of MVP).** Edge detection, signed transport,
> and the reclaim path work. The booking API and the scheduled enforcement sweep
> are in progress. See [`docs/AUDIT.md`](docs/AUDIT.md) for a full defect log and
> roadmap.

---

## The problem

In a university with 60 classrooms, 15–25% of bookings are no-shows. Each empty
room keeps running roughly 4.3 kW of AC and lighting for the full slot, while
students who need a room are told none is available.

Existing fixes fail in predictable ways: honour-system cancellation gets ignored,
card-swipe check-in needs new hardware on every door, and camera surveillance is
a privacy and compliance problem nobody wants to own.

## The approach

Run detection **on the edge device inside the room**. The camera frame is
analysed in memory and discarded. What leaves the room is a single JSON object:

```json
{ "room_id": "room_101", "status": "vacant", "confidence": 0.91,
  "timestamp": "2026-08-01T09:14:22+00:00", "signature": "hmac-sha256..." }
```

There is no image to leak, subpoena, or breach. That is the core design
commitment, and it drives every other decision in the system.

---

## Architecture

```
┌─────────────────────── EDGE DEVICE (Raspberry Pi 4 / Jetson Nano) ─────────┐
│                                                                            │
│  camera_capture.py ──► human_presence.py ──► orchestrator.py               │
│  frame in memory      MediaPipe pose         debounce + SQLite queue       │
│  never persisted      (HOG fallback)         offline-safe, dead-letter     │
│                                                    │                       │
└────────────────────────────────────────────────────┼───────────────────────┘
                                                     │ HTTPS + HMAC-SHA256
                                                     ▼
┌─────────────────────── FIREBASE CLOUD FUNCTIONS ──────────────────────────┐
│                                                                            │
│  receiveOccupancy ──► verify signature, reject replays, normalise schema   │
│         │                                                                  │
│         ▼  writes occupancy/                                               │
│  handleOccupancy ───► booking active + room empty past grace period?       │
│         │                                                                  │
│         ▼                                                                  │
│  sendLateArrivalWarning ──► FCM push, 5-minute confirmation window         │
│         │                                                                  │
│    ┌────┴─────┐                                                            │
│    ▼          ▼                                                            │
│ confirmed   ignored ──► cancelUnconfirmedBookings (scheduled, every 1 min) │
│ no action              cancel booking, release room, append audit log      │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                        Admin dashboard (Firebase Hosting)
```

### Design decisions worth noting

**Temporal debounce, not single-frame verdicts.** A person looking down or
sitting behind a monitor produces false negatives. `PresenceDetector` requires
7 of the last 10 frames to agree before flipping state, and starts in the
*occupied* state so it never accuses anyone before it has evidence.

**Offline-first edge.** Campus Wi-Fi drops. Payloads persist to SQLite with
exponential backoff and wall-clock-scheduled retries that never block the
capture loop. Exhausted payloads move to a dead-letter table rather than being
deleted, so failures stay auditable.

**Signed transport with replay protection.** Every payload carries an
HMAC-SHA256 signature over canonical JSON, verified with a constant-time
comparison. Payloads outside a 5-minute freshness window are rejected —
otherwise a captured "occupied" message could be replayed to keep a ghost
booking alive indefinitely.

**Idempotent enforcement.** Deterministic document IDs mean a retried or
duplicated function invocation overwrites rather than double-punishes.

**Append-only audit trail.** `firestore.rules` denies update and delete on
`audit_logs` and `decision_logs` to every client, including admins. Only the
Admin SDK writes there.

---

## Current status

| Component | State | |
|-----------|-------|--|
| Edge capture | Auto-recovers from camera disconnect | 85% |
| Presence detection | MediaPipe + HOG fallback, debounced | 70% |
| Signed transport | HMAC, offline queue, dead-letter | 85% |
| Backend ingest | Signature + replay verification | 80% |
| Enforcement judging | Needs scheduled sweep | 45% |
| Notify / confirm loop | Chain incomplete | 40% |
| Room reclaim | Cancels booking, frees room | 65% |
| Energy control | Mock only, not yet wired | 15% |
| Booking API | Not built | 0% |
| Admin dashboard | Renders; auth pending | 30% |
| Tests / CI | Not built | 0% |

Known defects are tracked openly in [`docs/AUDIT.md`](docs/AUDIT.md).

---

## Quick start

### Prerequisites
Node 18, Python 3.9+, a Firebase project with Firestore and Cloud Functions,
and a webcam or Raspberry Pi Camera Module.

### 1. Backend

```bash
cp .firebaserc.example .firebaserc     # add your project ID
cd functions && npm install

# Shared secret — must match the edge device exactly
openssl rand -hex 32                   # copy the output
firebase functions:config:set ghost.hmac_secret="<paste it>"

firebase deploy --only functions,firestore:rules,firestore:indexes
```

### 2. Edge device

```bash
cd edge_ai
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

cp ../.env.example ../.env             # set GHOST_HMAC_SECRET, ROOM_ID, backend URL
export $(grep -v '^#' ../.env | xargs)

python human_presence.py               # verify detection works on your camera
python orchestrator.py                 # start the full pipeline
```

### 3. Dashboard

Add your Firebase web config to `dashboard/app.js`, then:

```bash
firebase deploy --only hosting
```

### Local development

```bash
firebase emulators:start               # functions + Firestore + hosting
```

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `GHOST_HMAC_SECRET` | — | **Required.** Shared secret; must match backend |
| `GHOST_BACKEND_URL` | — | **Required.** `receiveOccupancy` endpoint URL |
| `ROOM_ID` | `room_unknown` | Room this device monitors |
| `GHOST_CAPTURE_INTERVAL` | `2.0` | Seconds between frames |
| `GHOST_WINDOW_SIZE` | `10` | Debounce sliding-window size |
| `GHOST_FLIP_THRESHOLD` | `7` | Frames that must agree to flip state |
| `GHOST_MIN_CONFIDENCE` | `0.5` | Per-frame detection threshold |
| `GHOST_HEARTBEAT_SECONDS` | `60` | Resend interval, distinguishes vacant from offline |

Full list in [`.env.example`](.env.example).

---

## Privacy and compliance

- Frames are analysed in RAM and never written to disk or transmitted.
- Payloads contain a room ID, a boolean, a confidence score, and a timestamp.
- No face recognition, no identification, no headcount, no biometrics.
- Audit logs are append-only and contain no personal data.

Deployments in India fall under the DPDP Act 2023. Signage and a documented
DPIA are required before any live rollout. The zero-retention architecture is
designed to make that assessment straightforward.

---

## Roadmap

**Next:** scheduled enforcement sweep, booking API, authenticated confirm
endpoint, dashboard login.
**Then:** Google Calendar / Outlook integration, emulator integration tests,
CI, real smart-plug control replacing the energy mock.
**Later:** multi-tenancy, measured accuracy benchmark, hardware BOM and
cost-per-room payback model.

## Licence

MIT — see [LICENSE](LICENSE).
