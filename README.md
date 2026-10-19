# Ghost Resource Buster

[![CI](https://github.com/aryan-guptta-2007/The-Ghost/actions/workflows/ci.yml/badge.svg)](https://github.com/aryan-guptta-2007/The-Ghost/actions/workflows/ci.yml)

**Privacy-first occupancy enforcement for shared rooms.** It detects rooms that
are booked but empty, gives the owner a chance to say "I'm here", and otherwise
releases the room and records the energy saved. No image or video ever leaves
the room.

> **Status: working MVP (~80%).** The full detect → warn → confirm/reclaim loop
> runs end to end, covered by emulator tests and CI. Open items are calendar
> integration, a push-notification client and per-device keys. See
> [`docs/AUDIT.md`](docs/AUDIT.md) for the engineering log.

---

## Try it in two minutes, no camera needed

Requirements: Node 22, Java 21+ and the Firebase CLI (`npm i -g firebase-tools`).

```bash
cd functions
npm install
npm run demo
```

This starts the Firebase emulators, seeds four rooms, and plays three stories
through the real backend with correctly signed sensor payloads:

| Room | Story | What happens (from a real run) |
|---|---|---|
| Seminar Room 101 | Booked, nobody shows up | warned at **+38s**, reclaimed at **+99s**, 4.18 kWh saved |
| Lecture Hall 102 | Booked, people present | left alone |
| Robotics Lab 103 | Booked, camera dies | warned at **+189s** (device silent > 3 min), reclaimed at **+250s** |
| Study Pod 104 | Free | yours to drive from the dashboard |

Open **http://127.0.0.1:5000** and click **Use the demo account**. On any room,
**Book now** → **Empty** shows the warning arrive, with a countdown, in both the
room card and your own "My bookings" banner. Click **I'm here** to keep the room,
or wait 60 seconds and watch it get reclaimed. Every decision appears in the
decision log as it happens.

Demo bookings use a 30-second grace period and a 60-second confirmation window.
Real bookings use 10 minutes and 5 minutes.

---

## The problem

In a university with 60 classrooms, 15–25% of bookings are no-shows. Each empty
room keeps running roughly 4.3 kW of AC and lighting for the full slot, while
students who need a room are told none is available.

The usual fixes fail in predictable ways. Honour-system cancellation gets
ignored, card-swipe check-in needs new hardware on every door, and camera
surveillance is a privacy and compliance problem nobody wants to own.

## The approach

Detection runs **on the edge device inside the room**. The frame is analysed
in memory and discarded. What leaves the room is a single JSON object:

```json
{ "room_id": "room_101", "status": "vacant", "confidence": 0,
  "timestamp": "2026-08-01T09:14:22+00:00", "signature": "hmac-sha256..." }
```

There is no image to leak, subpoena, or breach.

---

## Architecture

```
┌──────────────────── EDGE DEVICE (Raspberry Pi 4 / Jetson Nano) ────────────────────┐
│  camera_capture.py ──► human_presence.py ──► orchestrator.py                       │
│  frame in memory      MediaPipe pose          7-of-10 debounce, SQLite queue,      │
│  never persisted      (HOG fallback)          dead-letter, 60s heartbeat           │
└───────────────────────────────────────────────────┬────────────────────────────────┘
                                                    │ HTTPS + HMAC-SHA256
                                                    ▼
┌──────────────────────────── FIREBASE CLOUD FUNCTIONS ──────────────────────────────┐
│  receiveOccupancy   verify signature, reject stale + replayed payloads,            │
│        │            write occupancy/ and rooms/{id}.lastReading                    │
│        ▼                                                                           │
│  handleOccupancy ──────┐   (reacts to each reading)                                │
│  sweepActiveBookings ──┤   (every minute: catches vacant, silent, never-reported)  │
│                        ▼                                                           │
│        flagGhost: enforcement + confirmation in one transaction, FCM push          │
│                        │                                                           │
│        ┌───────────────┼──────────────────────────┐                                │
│        ▼               ▼                          ▼                                │
│  confirmAttendance   person walks in      cancelUnconfirmedBookings (every minute) │
│  (ID token, owner)   → cleared            cancel booking, free room, log kWh       │
│                                                                                    │
│  createBooking (ID token, transactional overlap check)                             │
└────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
               Dashboard (Firebase Hosting): live rooms, stats, decision log,
               "My bookings" with the I'm-here button, demo panel
```

### Design decisions

**Event-driven *and* time-driven.** A reading triggers enforcement instantly,
but a ghost booking often produces no reading at all because the camera is
dead or unplugged. A one-minute sweep treats silence longer than three minutes
as an empty room.

**Temporal debounce, not single-frame verdicts.** `PresenceDetector` needs 7 of
the last 10 frames to agree before flipping state, and it starts in the
*occupied* state so it never accuses anyone before it has evidence.

**Signed transport with replay protection.** HMAC-SHA256 over canonical JSON,
constant-time comparison, and a 5-minute freshness window. The signature
doubles as the occupancy document ID, so an exact replay is rejected with 409.
The Python signer and the JavaScript verifier share a test vector, which is
how I found that Python's `0.0` and JavaScript's `0` broke every vacant
reading.

**Idempotent enforcement.** Enforcement and confirmation docs are keyed by
booking ID and created in one transaction, so any number of readings, sweeps
or retries warn a booking at most once.

**Least-privilege clients.** `firestore.rules` lets clients read. Every write
that matters goes through a function: readings are HMAC-verified, bookings are
overlap-checked, confirmations need the owner's ID token. `audit_logs` and
`decision_logs` cannot be updated or deleted by anyone.

---

## Current status

| Component | State | |
|-----------|-------|--|
| Edge capture | Auto-recovers from camera disconnect | 85% |
| Presence detection | MediaPipe + HOG fallback, debounced | 70% |
| Signed transport | HMAC, offline queue, dead-letter, replay-safe | 90% |
| Backend ingest | Signature, freshness, replay, unknown-room checks | 95% |
| Enforcement | Trigger + scheduled sweep, idempotent | 90% |
| Warn / confirm loop | Backend-driven, ID-token authenticated | 80% |
| Room reclaim + energy | Cancels, frees room, records kWh released | 90% |
| Booking API | Overlap-checked API, booking form, seed script | 70% |
| Dashboard | Login, roles, live state, demo panel | 85% |
| Tests / CI | 23 Node tests (emulator + unit), 7 edge tests, GitHub Actions | 85% |

What's left, and why, is in [`docs/AUDIT.md`](docs/AUDIT.md#known-limitations).

---

## Deploying

```bash
cp .firebaserc.example .firebaserc        # add your project ID
cd functions && npm install

# Shared secret, stored in Secret Manager. It must match the edge device.
openssl rand -hex 32
firebase functions:secrets:set GHOST_HMAC_SECRET

firebase deploy --only functions,firestore,hosting
```

Then create accounts in Firebase Auth and give them roles:

```bash
node scripts/set-role.js you@example.com admin --project <id>

# Optional public demo: seeds demo rooms and a read-only demo account
DEMO_PASSWORD=<pick one> node scripts/seed.js --project <id>
```

To put a **Use the demo account** button on the live dashboard, add
`dashboard/demo-login.json` containing `{ "email": "demo@ghost-buster.test",
"password": "<DEMO_PASSWORD>" }` and redeploy hosting. The demo role can read
everything and drive only rooms flagged `demo: true`. It cannot touch real
bookings.

The dashboard needs no pasted config: it loads it from Hosting's
`/__/firebase/init.json`.

### Edge device

```bash
cd edge_ai
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

cp ../.env.example ../.env     # set GHOST_HMAC_SECRET, ROOM_ID, GHOST_BACKEND_URL
export $(grep -v '^#' ../.env | xargs)

python human_presence.py       # check detection on your camera
python orchestrator.py         # run the full pipeline
```

No camera? `node functions/scripts/simulate.js room_101=vacant --every 30 --project <id>`
sends the same signed payloads.

---

## Testing

```bash
cd functions
npm run lint
npm test                 # starts Firestore + Auth emulators, runs all Node tests
npm run test:unit        # pure logic only, no emulator

python -m pytest edge_ai/tests
```

The emulator suite covers the ghost path, the confirm path (with real ID
tokens), presence clearing a warning, replay and forgery, devices going
offline, booking overlaps, and the demo permissions.

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `GHOST_HMAC_SECRET` | — | **Required.** Shared secret; must match the backend secret |
| `GHOST_BACKEND_URL` | — | **Required.** `receiveOccupancy` URL |
| `ROOM_ID` | `room_unknown` | Room this device monitors (must exist in `rooms/`) |
| `GHOST_CAPTURE_INTERVAL` | `2.0` | Seconds between frames |
| `GHOST_WINDOW_SIZE` | `10` | Debounce window |
| `GHOST_FLIP_THRESHOLD` | `7` | Frames that must agree to flip state |
| `GHOST_HEARTBEAT_SECONDS` | `60` | Resend interval, so silence means "offline" |

Backend timings (10-minute grace, 5-minute confirmation window, 3-minute
staleness, default 4.3 kW room draw) live in
[`functions/lib/config.js`](functions/lib/config.js).

---

## Privacy and compliance

- Frames are analysed in RAM and never written to disk or transmitted.
- Payloads carry a room ID, a boolean, a confidence score and a timestamp.
- No face recognition, no identification, no headcount, no biometrics.
- Audit logs are append-only and contain no personal data.

Deployments in India fall under the DPDP Act 2023. Signage and a documented
DPIA are required before any live rollout. The zero-retention design is meant
to make that assessment straightforward.

## Roadmap

**Next:** a PWA that registers for push, per-device signing keys, and
re-checking a booking after its owner confirms.
**Then:** Google Calendar and Outlook integration, and smart-plug control so
the energy figure is measured instead of estimated.
**Later:** multi-tenancy, an accuracy benchmark over real classrooms, and a
hardware BOM with a cost-per-room payback model.

## Licence

MIT. See [LICENSE](LICENSE).
