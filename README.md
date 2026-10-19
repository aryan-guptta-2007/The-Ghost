# Ghost Resource Buster

[![CI](https://github.com/aryan-guptta-2007/The-Ghost/actions/workflows/ci.yml/badge.svg)](https://github.com/aryan-guptta-2007/The-Ghost/actions/workflows/ci.yml)

**Privacy-first occupancy enforcement for shared rooms.** It detects rooms that
are booked but empty, gives the owner a chance to say "I'm here", and otherwise
releases the room and records the energy saved. No image or video ever leaves
the room.

> **Status: working MVP (~80%).** The full detect → warn → confirm/reclaim loop
> runs end to end, covered by emulator tests and CI, and production runs on
> free tiers (Firebase Spark + Vercel Hobby, no credit card). Open items are
> calendar integration, a push-notification client and per-device keys. See
> [`docs/AUDIT.md`](docs/AUDIT.md) for the engineering log.

---

## Try it in two minutes, no camera needed

Requirements: Node 22, Java 21+ and the Firebase CLI (`npm i -g firebase-tools`).

```bash
cd backend
npm install
npm run demo
```

This starts the Firebase emulators and a local copy of the API (the same
handlers Vercel runs), seeds four rooms, and plays three stories with
correctly signed sensor payloads:

| Room | Story | What happens (from a real run) |
|---|---|---|
| Seminar Room 101 | Booked, nobody shows up | warned at **+30s**, reclaimed at **+90s**, 4.19 kWh saved |
| Lecture Hall 102 | Booked, people present | left alone |
| Robotics Lab 103 | Booked, camera dies | warned once the device has been silent for 3 min, reclaimed a minute later |
| Study Pod 104 | Free | yours to drive from the dashboard |

Open **http://127.0.0.1:5000** and click **Use the demo account**. On any room,
**Book now** → **Empty** shows the warning arrive, with a countdown, in both the
room card and your own "My bookings" banner. Click **I'm here** to keep the room,
or wait 60 seconds and watch it get reclaimed. Every decision appears in the
decision log as it happens.

Demo bookings use a 30-second grace period and a 60-second confirmation window,
and the demo treats a sensor as silent after 3 minutes. Production uses 10
minutes, 5 minutes and 12 minutes.

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
│  never persisted      (HOG fallback)          dead-letter, 5-min heartbeat         │
└───────────────────────────────────────────────────┬────────────────────────────────┘
                                                    │ HTTPS + HMAC-SHA256
                                                    ▼
┌──────────────────────── VERCEL SERVERLESS (Hobby) — backend/api ───────────────────┐
│  POST /api/occupancy  verify signature, reject stale/replayed readings,            │
│        │              update rooms/{id}.lastReading, then judge it right away      │
│        ▼                                                                           │
│  flagGhost: enforcement + confirmation in one transaction, FCM push                │
│        │                                                                           │
│        ├──► POST /api/confirm   owner says "I'm here" (Firebase ID token)          │
│        ├──► person walks in     next reading clears the warning                    │
│        └──► POST /api/cron      every minute from cron-job.org (secret header):    │
│                                 reclaim expired warnings (cancel, free, log kWh);  │
│                                 every 5th minute also sweep for silent devices     │
│                                                                                    │
│  POST /api/bookings (ID token, transactional overlap check)                        │
│  POST /api/demo     (demo panel; staff only, demo rooms only)                      │
└────────────────────────────────┬───────────────────────────────────────────────────┘
                                 │ firebase-admin (service account key in Vercel env)
                                 ▼
┌──────────────────────────── FIREBASE (Spark, free) ────────────────────────────────┐
│  Firestore (security rules: clients read, backend writes)    Auth (email/password) │
│  Hosting: dashboard — live rooms, stats, decision log, "My bookings", demo panel   │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Design decisions

**Free by design.** Cloud Functions needs Firebase's paid Blaze plan, so the
backend runs as Vercel serverless functions and talks to Firestore with the
Admin SDK. There are no Firestore triggers on Vercel, so a reading is judged in
the same request that stores it. The heartbeat, sweep cadence and storage
layout are sized for Firestore's free daily quota (see
[Running for free](#running-for-free)).

**Event-driven *and* time-driven.** A reading triggers enforcement instantly,
but a ghost booking often produces no reading at all because the camera is
dead or unplugged. The sweep treats a sensor that has been silent for 12
minutes as an empty room.

**Temporal debounce, not single-frame verdicts.** `PresenceDetector` needs 7 of
the last 10 frames to agree before flipping state, and it starts in the
*occupied* state so it never accuses anyone before it has evidence.

**Signed transport with replay protection.** HMAC-SHA256 over canonical JSON,
constant-time comparison, a 5-minute freshness window, and a rule that each
reading must be newer than the room's last one. An exact replay or a stale
out-of-order delivery gets 409, and no per-reading document is needed. The
Python signer and the JavaScript verifier share a test vector, which is how I
found that Python's `0.0` and JavaScript's `0` broke every vacant reading.

**Idempotent enforcement.** Enforcement and confirmation docs are keyed by
booking ID and created in one transaction, so any number of readings, sweeps
or retries warn a booking at most once.

**Least-privilege clients.** `firestore.rules` lets clients read. Every write
that matters goes through the API: readings are HMAC-verified, bookings are
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
| Enforcement | Judged on arrival + cron sweep, idempotent | 90% |
| Warn / confirm loop | Backend-driven, ID-token authenticated | 80% |
| Room reclaim + energy | Cancels, frees room, records kWh released | 90% |
| Booking API | Overlap-checked API, booking form, seed script | 70% |
| Dashboard | Login, roles, live state, demo panel | 85% |
| Tests / CI | 33 Node tests (emulator + unit), 7 edge tests, GitHub Actions | 85% |

What's left, and why, is in [`docs/AUDIT.md`](docs/AUDIT.md#known-limitations).

---

## Deploying (₹0, no credit card)

Four free services: **Firebase Spark** (Firestore, Auth, Hosting),
**Vercel Hobby** (the API), **cron-job.org** (the once-a-minute trigger), and
GitHub. Steps marked 🔑 need you to sign in; nothing here asks for a card.

### 1. Firebase project (Spark)

1. 🔑 In the [Firebase console](https://console.firebase.google.com), create a
   project and leave it on the **Spark** plan. Add a **Web app**, enable
   **Authentication → Email/Password**, and create a **Firestore** database.
2. Deploy rules, indexes and the dashboard. None of these need Blaze:

   ```bash
   cp .firebaserc.example .firebaserc     # put your project ID in it
   firebase login                         # 🔑
   firebase deploy --only firestore,hosting
   ```

3. 🔑 **Project settings → Service accounts → Generate new private key.**
   This downloads a JSON key with full admin access to the project. Save it
   **outside this repo** (for example `~/keys/ghost-buster.json`). You will
   paste it into Vercel in step 2 and then can delete the file. Never commit
   it; `.gitignore` blocks the usual key filenames as a backstop.

### 2. API on Vercel (Hobby)

1. 🔑 On [vercel.com](https://vercel.com), **Add New → Project**, import this
   GitHub repo, and set **Root Directory** to `backend`. No build command is
   needed.
2. Under **Settings → Environment Variables**, add these for the
   **Production** environment only. Keeping them out of Preview means a
   branch build can't read your admin key.

   | Name | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | the entire contents of the key JSON |
   | `GHOST_HMAC_SECRET` | `openssl rand -hex 32` (edge devices use the same value) |
   | `CRON_SECRET` | `openssl rand -hex 32` (a different value) |
   | `ALLOWED_ORIGINS` | `https://<project-id>.web.app,https://<project-id>.firebaseapp.com` |

3. Deploy. Your API is at `https://<your-app>.vercel.app/api`.
4. Point the dashboard at it by editing `dashboard/api-config.json` and
   redeploying hosting:

   ```json
   { "apiBase": "https://<your-app>.vercel.app/api", "staleSeconds": 720 }
   ```

   ```bash
   firebase deploy --only hosting
   ```

### 3. The every-minute trigger (cron-job.org)

Vercel Hobby's own cron runs at most once a day, so the minute-level trigger
comes from [cron-job.org](https://cron-job.org) (free).

🔑 Create a cron job:

- **URL:** `https://<your-app>.vercel.app/api/cron`
- **Schedule:** every minute
- **Advanced → Headers:** `Authorization: Bearer <CRON_SECRET>`

Requests without that header get 401. Each call reclaims expired warnings, and
every 5th minute it also sweeps for silent devices.

### 4. Accounts and roles

Sign up users in **Authentication → Users**, then grant roles. These scripts
use the key from step 1 through `GOOGLE_APPLICATION_CREDENTIALS`:

```bash
cd backend && npm install
export GOOGLE_APPLICATION_CREDENTIALS=~/keys/ghost-buster.json

node scripts/set-role.js you@example.com admin --project <id>

# Optional public demo: seeds demo rooms and a read-only demo account
DEMO_PASSWORD=<pick one> node scripts/seed.js --project <id>
```

To put a **Use the demo account** button on the live dashboard, add
`dashboard/demo-login.json` containing `{ "email": "demo@ghost-buster.test",
"password": "<DEMO_PASSWORD>" }` and redeploy hosting. The demo role can read
everything and drive only rooms flagged `demo: true`. It cannot touch real
bookings.

### Edge device

```bash
cd edge_ai
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

cp ../.env.example ../.env     # GHOST_HMAC_SECRET, ROOM_ID, GHOST_BACKEND_URL=https://<your-app>.vercel.app/api/occupancy
export $(grep -v '^#' ../.env | xargs)

python human_presence.py       # check detection on your camera
python orchestrator.py         # run the full pipeline
```

No camera? This sends the same signed payloads:

```bash
GHOST_HMAC_SECRET=<value from Vercel> node backend/scripts/simulate.js room_101=vacant \
  --every 300 --api https://<your-app>.vercel.app/api
```

---

## Running for free

**Firestore (Spark):** 50,000 reads, 20,000 writes and 20,000 deletes per day,
and 1 GiB stored. Quotas reset around midnight Pacific time, and when one runs
out, Firestore refuses requests until the reset. Nothing is billed.

What each part costs, from the code paths:

| Source | Writes | Reads |
|---|---|---|
| Heartbeat (one per room every 5 min = 288/day) | 1 | ~3 (room, booking lookup, open warning) |
| Cron reclaim check (every minute = 1,440/day) | — | 1 when nothing expired |
| Cron sweep (every 5 min = 288/day) | — | 1 + 2 per running booking |
| Booking created | 1 | ~2 |
| Ghost warned, then reclaimed | ~11 | ~7 |
| Open dashboard | — | ~160 on load, then 1 per room per heartbeat |

**Example: 20 rooms, each booked 8 hours a day, about 32 no-shows a day, two
dashboards open through the working day:**

| | Per day | Spark limit | Used |
|---|---|---|---|
| Writes | ~6,400 | 20,000 | 32% |
| Reads | ~28,800 | 50,000 | 58% |
| Deletes | 0 | 20,000 | 0% |
| Stored data | grows by a few KB a day (logs only) | 1 GiB | ~0% |

Reads are the binding limit, at roughly 1,250 per room per day, so the ceiling
is **about 35 rooms**. Beyond that, raise `GHOST_HEARTBEAT_SECONDS` on the
devices (raise `GHOST_STALE_SECONDS` on Vercel to match, about 2.4× the
heartbeat) or `GHOST_SWEEP_EVERY_MINUTES`.

These are the choices that made it fit. A 60-second heartbeat that stored a
document per reading cost about 4,300 writes per room per day, which is only
4–5 rooms on the free tier.

**Vercel (Hobby):** 1,000,000 function invocations and **4 hours of Active
CPU** per month, with a 300-second maximum duration (this project sets 10s).
The 20-room example makes about 220,000 invocations a month (heartbeats plus
43,200 cron calls), so the CPU budget averages out to about 65 ms per request.
These handlers mostly wait on Firestore, which is not CPU time, but cold
starts load firebase-admin. **Check Usage → Active CPU after the first day.**
If it trends past 4 hours a month, lengthen the heartbeat. Hobby is for
**non-commercial personal use only**; anything paid needs Vercel Pro.

**Firebase Hosting (Spark):** 10 GB stored, 360 MB/day transfer. The dashboard
is about 40 KB, and the Firebase SDK loads from Google's CDN.

---

## Testing

```bash
cd backend
npm run lint
npm test                 # starts Firestore + Auth emulators, runs all Node tests
npm run test:unit        # pure logic only, no emulator
npm run dev              # emulators + local API on http://127.0.0.1:5100/api, no scripted story

python -m pytest edge_ai/tests
```

The emulator suite covers the ghost path, the confirm path (with real ID
tokens), presence clearing a warning, replay and forgery, devices going
offline, booking overlaps, the demo permissions, and the Vercel endpoints
themselves: cron secret, CORS allowlist, and method and status mapping.

---

## Configuration

**Edge device** (`.env`, see [`.env.example`](.env.example)):

| Variable | Default | Purpose |
|----------|---------|---------|
| `GHOST_HMAC_SECRET` | — | **Required.** Must equal the value in Vercel |
| `GHOST_BACKEND_URL` | — | **Required.** `https://<your-app>.vercel.app/api/occupancy` |
| `ROOM_ID` | `room_unknown` | Room this device monitors (must exist in `rooms/`) |
| `GHOST_CAPTURE_INTERVAL` | `2.0` | Seconds between frames |
| `GHOST_WINDOW_SIZE` | `10` | Debounce window |
| `GHOST_FLIP_THRESHOLD` | `7` | Frames that must agree to flip state |
| `GHOST_HEARTBEAT_SECONDS` | `300` | Resend interval, so silence means "offline". State changes are sent immediately |

**API** (Vercel environment variables):

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | — | **Required.** Service account key JSON |
| `GHOST_HMAC_SECRET` | — | **Required.** Shared with the edge devices |
| `CRON_SECRET` | — | **Required.** Bearer token cron-job.org sends |
| `ALLOWED_ORIGINS` | — | **Required.** Comma-separated Hosting origins allowed to call the API |
| `GHOST_STALE_SECONDS` | `720` | Silence after which a device counts as offline |
| `GHOST_SWEEP_EVERY_MINUTES` | `5` | How often the cron call also sweeps |

Without the required secrets the API fails closed. Placeholder values are used
only against the local emulators.

Booking timings (10-minute grace, 5-minute confirmation window) and the
default 4.3 kW room draw live in [`backend/lib/config.js`](backend/lib/config.js).

---

## Privacy and compliance

- Frames are analysed in RAM and never written to disk or transmitted.
- Payloads carry a room ID, a boolean, a confidence score and a timestamp.
- Only each room's latest reading is stored; there is no sensor history.
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
