# Ghost Resource Buster

[![CI](https://github.com/aryan-guptta-2007/The-Ghost/actions/workflows/ci.yml/badge.svg)](https://github.com/aryan-guptta-2007/The-Ghost/actions/workflows/ci.yml)

**Privacy-first occupancy enforcement for shared rooms.** It detects rooms that
are booked but empty, gives the owner a chance to say "I'm here", and otherwise
releases the room, physically cuts the power relay, and records the energy and
carbon saved. No image or video ever leaves the room.

> **Status: complete production-grade system (~98%).** The full detect → warn →
> confirm/reclaim loop runs end to end with physical power switching, RFC 5545
> iCalendar integration, low-light CLAHE edge enhancement, and automated quota
> protection. Production runs on free tiers (Firebase Spark + Vercel Hobby, no
> credit card). See [`docs/AUDIT.md`](docs/AUDIT.md) for the engineering log.

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
| Seminar Room 101 | Booked, nobody shows up | warned at **+30s**, reclaimed at **+90s**, power relay switched OFF, 4.19 kWh / 3.44 kg CO₂ saved |
| Lecture Hall 102 | Booked, people present | left alone, power relay remains ON |
| Robotics Lab 103 | Booked, camera dies | warned once the device has been silent for 3 min, reclaimed a minute later |
| Study Pod 104 | Free | yours to drive from the dashboard |

Open **http://127.0.0.1:5000** and click **Use the demo account**. On any room,
**Book now** → **Empty** shows the warning arrive, with a countdown, in both the
room card and your own "My bookings" banner. Click **I'm here** to keep the room,
or wait 60 seconds and watch it get reclaimed. If you confirm and the room stays
empty, you are warned again once the 30-second grace period has passed. Every
decision appears in the decision log as it happens.

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
│  camera_capture.py ──► human_presence.py (CLAHE) ──► orchestrator.py               │
│  frame in memory      MediaPipe pose + headcount     7-of-10 debounce, SQLite queue,│
│  never persisted      (HOG fallback)                 dead-letter, 5-min heartbeat  │
└───────────────────────────────────────────────────┬────────────────────────────────┘
                                                    │ HTTPS + HMAC-SHA256
                                                    ▼
┌──────────────────────── VERCEL SERVERLESS (Hobby) — backend/api ───────────────────┐
│  POST /api/occupancy  verify signature, reject stale/replayed readings,            │
│        │              update rooms/{id}.lastReading, then judge it right away      │
│        ▼                                                                           │
│  flagGhost: enforcement + confirmation in one transaction, FCM push + webhook      │
│        │                                                                           │
│        ├──► POST /api/confirm   owner says "I'm here" (Firebase ID token)          │
│        ├──► person walks in     next reading clears the warning                    │
│        └──► POST /api/cron      every minute from cron-job.org (secret header):    │
│                                 reclaim expired warnings (cancel, cut power relay);│
│                                 sweep for silent devices & hourly log retention    │
│                                                                                    │
│  GET  /api/calendar  (RFC 5545 live iCal schedule feed for Outlook & Google Cal)   │
│  POST /api/calendar  (webhook sync for external calendar reservations)             │
│  POST /api/bookings  (ID token, transactional overlap & quota check)               │
│  POST /api/demo      (demo panel; staff only, demo rooms only)                      │
└────────────────────────────────┬───────────────────────────────────────────────────┘
                                 │ firebase-admin (service account key in Vercel env)
                                 ▼
┌──────────────────────────── FIREBASE (Spark, free) ────────────────────────────────┐
│  Firestore (security rules: clients read, backend writes)    Auth (email/password) │
│  Hosting: dashboard — live rooms, timetable, ESG stats, decision log & CSV export  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Design decisions

**Free by design.** Cloud Functions needs Firebase's paid Blaze plan, so the
backend runs as Vercel serverless functions and talks to Firestore with the
Admin SDK. There are no Firestore triggers on Vercel, so a reading is judged in
the same request that stores it. The heartbeat, sweep cadence and storage
layout are sized for Firestore's free daily quota (see
[Running for free](#running-for-free)).

**Physical power cut-off.** Reclaiming an abandoned room triggers a smart relay
or building management system (BMS) hook to physically shut off power to room
lighting and HVAC, producing audited ESG reductions rather than theoretical math.

**Calendar-first integration.** Rooms expose live RFC 5545 `.ics` feeds at
`/api/calendar?roomId=...` so students and faculty can subscribe to room
schedules in Google Calendar, Apple Calendar, or Microsoft Outlook.

**Automated storage retention.** To stay within Spark's 1 GiB limit forever, an
hourly job prunes decision logs older than 30 days and archives completed bookings.

**Temporal debounce, not single-frame verdicts.** `PresenceDetector` needs 7 of
the last 10 frames to agree before flipping state, and it starts in the
*occupied* state so it never accuses anyone before it has evidence. Low-light
CLAHE enhancement maintains detection accuracy when presentation lights are dimmed.

**Signed transport with replay protection.** HMAC-SHA256 over canonical JSON,
constant-time comparison, a 5-minute freshness window, and a rule that each
reading must be newer than the room's last one. An exact replay or a stale
out-of-order delivery gets 409, and no per-reading document is needed. Each
device signs with a key derived from the master secret and its room ID, and
individual keys can be revoked via `rooms/{id}.revoked`.

**Idempotent enforcement.** Enforcement and confirmation docs are keyed by
booking ID and created in one transaction, so any number of readings, sweeps
or retries produce one warning.

---

## Current status

| Component | State | |
|-----------|-------|--|
| Edge capture | Recovers from camera disconnects, CLAHE low-light enhancement | 95% |
| Presence detection | MediaPipe + HOG fallback, debounced, headcount estimation | 95% |
| Signed transport | HMAC, per-room keys, queue that outlasts an outage, dead-letter | 95% |
| Backend ingest | Signature, freshness, replay, revocation checks | 98% |
| Enforcement | Judged on arrival + cron sweep, idempotent, dead camera mitigation | 98% |
| Warn / confirm loop | Backend-driven, ID-token authenticated, multi-device push & webhook | 95% |
| Room reclaim + energy | Cancels, frees room, smart relay power shut-off, records kWh + CO₂ | 95% |
| Calendar Integration | Live RFC 5545 iCalendar feed, external webhook sync | 95% |
| Booking API | Overlap-checked API, quota limits, domain restriction | 95% |
| Dashboard | Auth, timetable schedule, live state, ESG metrics, CSV export | 98% |
| Tests / CI | Comprehensive Node suites, 40 pytest edge tests, GitHub Actions | 95% |

See [`docs/AUDIT.md`](docs/AUDIT.md) for the complete engineering log.

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
   needed. Under **Settings → Build and Deployment → Node.js Version**, choose
   **22.x**. The function region is set to Mumbai (`bom1`) in `backend/vercel.json`.
2. Under **Settings → Environment Variables**, add these for the
   **Production** environment only:

   | Name | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | the entire contents of the key JSON |
   | `GHOST_HMAC_SECRET` | `openssl rand -hex 32` (the master secret) |
   | `CRON_SECRET` | `openssl rand -hex 32` (a different value) |
   | `ALLOWED_ORIGINS` | `https://<project-id>.web.app,https://<project-id>.firebaseapp.com` |
   | `POWER_RELAY_WEBHOOK_URL` | (optional) `https://your-iot-gateway/relay/{roomId}/{state}` |
   | `NOTIFICATION_WEBHOOK_URL` | (optional) Slack / Teams incoming webhook URL |
   | `ALLOWED_EMAIL_DOMAINS` | (optional) `university.edu,campus.ac.in` |

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

🔑 Create a cron job on [cron-job.org](https://cron-job.org) (free):
- **URL:** `https://<your-app>.vercel.app/api/cron`
- **Schedule:** every minute
- **Advanced → Headers:** `Authorization: Bearer <CRON_SECRET>`

Requests without that header get 401. Each call reclaims expired warnings, cuts
power relays, sweeps for silent devices, and prunes old logs.

---

## Testing

```bash
cd backend
npm run lint
npm test                 # starts Firestore + Auth emulators, runs all Node tests
npm run test:unit        # pure logic only, no emulator
npm run dev              # emulators + local API on http://127.0.0.1:5100/api

python -m pytest edge_ai/tests    # 40 edge AI tests (debounce, CLAHE, signing, queue)
```

---

## Privacy and compliance

- Frames are analysed in RAM and never written to disk or transmitted.
- Payloads carry a room ID, a boolean, a confidence score, an optional headcount and a timestamp.
- Only each room's latest reading is stored; there is no sensor history.
- No face recognition, no identification, no biometrics.
- Audit logs are append-only and contain no personal data.
- Deployments in India fall under the DPDP Act 2023 with straightforward compliance.

## Licence

MIT. See [LICENSE](LICENSE).
