# Engineering log

I built the first version of Ghost Resource Buster quickly, and when I went back
through it line by line, it could not complete a single detect → warn → reclaim
cycle. The architecture held up. The wiring between the pieces did not. This is
the record of what I found, how I fixed it, and what is still open.

Defect numbers are stable, so commits and issues can refer to them.

---

## The flow

```
Camera (edge device)
   -> detect a person locally, discard the frame
   -> POST signed {room, occupied?, confidence} to receiveOccupancy
        -> booking running, room empty past its grace period?
             -> warn the owner (push + dashboard), open a confirmation window
                  -> owner confirms, or a person walks in -> stand down
                  -> nobody answers  -> cancel booking, free the room,
                                        record the energy saved
```

The part I am most sure of is the privacy design. No frame ever leaves the room,
only a boolean and a confidence score. Everything else is built around that.

---

## Round 1: making it run at all

The first version could not detect anyone, could not deploy, and its edge and
backend could not talk to each other.

| # | What I found | Fix |
|---|---|---|
| 1 | **There was no presence detection.** `orchestrator.py` computed `"occupied" if shape else "vacant"`, and `shape` is always truthy. Every room was "occupied" forever. | Wrote `human_presence.py`: MediaPipe pose with an OpenCV HOG fallback, plus a 7-of-10 frame debounce. Tuning notes are in [`BENCHMARK.md`](BENCHMARK.md). |
| 2 | `camera_capture.py` dropped every frame and yielded only its shape. | It now yields the frame in memory. Frames are still never written or sent. |
| 3 | The `receiveOccupancy` endpoint the edge posted to did not exist, so the HMAC signature was verified nowhere. | Wrote `receive_occupancy.js`. |
| 4 | `admin.initializeApp()` was called in five files, which crashes a Functions deploy. | One shared `lib/firebase.js`. |
| 5 | `index.js` exported only `handleOccupancy`, so three functions never deployed. | A barrel `index.js`. |
| 6 | The edge sent `room_id`/`status`/float timestamps; the backend read `roomId`/`humanPresent`/Firestore Timestamps. | A normalisation layer at ingest. |
| 7 | No `package.json`, `requirements.txt`, `firebase.json`, rules or indexes. | Added all of them. |
| 8 | `energy_controller.py` ended in a stray markdown fence, so it was not valid Python. | Removed; the module was later deleted (#19). |
| 9 | A Firestore transaction wrote before it read, which throws at runtime. | Reads hoisted above writes. |
| 10 | A non-transactional `.add()` inside a transaction duplicated audit rows on retry. | Deterministic audit doc IDs. |
| 15 | One bad frame could flag a real occupant. | The debounce from #1. |
| 16 | `time.sleep(backoff)` inside the capture loop froze detection for up to 60s. | Retries are scheduled by wall-clock time. |
| 17 | Payloads were silently deleted after five failed sends. | A dead-letter table. |

---

## Round 2: closing the loop

After round 1 the parts worked on their own, but the chain still stopped halfway.

| # | What I found | Fix |
|---|---|---|
| 24 | **The chain stopped halfway.** `handleOccupancy` wrote `enforcement: pending` and did nothing else. `sendLateArrivalWarning` was a callable that nothing called, so no confirmation was ever created and the reclaim job never had work. | `lib/enforcement.js` now owns the chain. `flagGhost` writes the enforcement record and the confirmation in one transaction, then sends the push from the backend. Both are keyed by booking ID, so a booking is warned at most once. The callable is gone. |
| 14 | **Enforcement only ran when a reading arrived.** A dead camera sends nothing, and that silence is exactly what a ghost booking looks like. | `sweepActiveBookings` runs every minute and warns on vacant, stale (>3 min) or never-reported rooms. It reads one denormalised `rooms/{id}.lastReading` per room in a single `getAll`, not a query per booking. |
| 13 | `handleOccupancy` range-filtered `startTime` and `endTime` in one query, which Firestore rejects. | Filter `startTime <= now` in Firestore and `endTime` in JavaScript. |
| 11 | **`confirmAttendance` was unauthenticated.** The `userId` check only ran if the caller chose to send one. | It requires a Firebase ID token and the caller must own the booking. Tested with real tokens from the Auth emulator. |
| 12 | Replay protection was only a 5-minute freshness window, so a captured "occupied" payload could be replayed inside it. | The signature is now the occupancy doc ID, so a second copy fails `create()` with 409. The edge treats 409 as delivered. |
| 23 | There was no way to create a booking, so nothing could be demoed. | `createBooking` checks for overlaps inside a transaction. The dashboard has a booking form, and `scripts/seed.js` seeds rooms and bookings. |
| 18, 19, 22 | **The energy figure was fiction.** The dashboard read a collection and fields the Python mock never wrote, nothing called the mock, and its maths counted occupied time as savings. | Dropped the Python mock. The reclaim job now computes `room powerKw × booking time released` and writes it to the audit log and `stats/global`, which the dashboard reads. |
| 20 | The dashboard had placeholder config and no login, so with the rules in place it showed only permission errors. | Config comes from Hosting's `/__/firebase/init.json`. Email sign-in, `admin` and read-only `demo` roles as custom claims. |
| 21 | The room list did a query per room inside a snapshot callback, which raced and duplicated cards. It also put `r.name` into `innerHTML`, which is an XSS hole. | One keyed card per room, updated in place with `textContent`. Room state comes from listeners on `rooms`, active bookings and enforcement, with no per-room reads. |
| 26 | **New: every vacant reading failed its signature check.** Python serialises `0.0` as `"0.0"` and JavaScript as `"0"`. A vacant room reports exactly `0.0`, so the canonical JSON differed and the backend returned 401. I only found this by writing a cross-language test vector. | The edge normalises whole floats to ints and signs raw UTF-8. Both test suites assert the same signature. |
| 27 | **New:** the "Reclaimed" card counted `status in ['resolved','canceled']`, but `resolved` meant a person *was* present, and the confirm path wrote `decision`, not `status`. | One status field per record (`warned → confirmed / cleared / reclaimed`) and counters maintained by the backend. |
| 28 | **New:** the secret used deprecated `functions.config()`, and the SDKs were two majors behind. | `defineSecret('GHOST_HMAC_SECRET')` via Secret Manager. Upgraded to firebase-functions 7 (v2 API) and firebase-admin 14. |
| 25 | No lint config, no tests, no CI, and `decision_logger.js` was imported by nothing. | ESLint flat config, Node tests (most against the Firestore and Auth emulators), 7 pytest tests on the edge, and GitHub Actions running both. Every decision is now written through `decision_logger.js` and shown in the dashboard's decision log. |

### What the tests cover

- **Ghost path:** vacant reading → warned → window expires → booking cancelled, room freed, kWh recorded.
- **Confirm path:** the owner confirms with a real ID token; another user gets 403; an expired window gets 410.
- **Presence:** a person walking in after a warning clears it with no confirmation needed.
- **Replay and forgery:** an exact replay gets 409; tampered, stale and unknown-room payloads are rejected.
- **Device offline:** silent, never-reporting and vacant rooms are warned; an occupied room is not.
- **Bookings:** overlap rejection and input validation.
- **Demo controls:** staff-only, demo rooms only, short timers.

---

## Round 3: running for ₹0

I want this live without a credit card. Cloud Functions requires Firebase's
paid Blaze plan, so I moved the backend to Vercel's free Hobby plan and kept
Firestore, Auth and Hosting on Spark.

| What changed | Why |
|---|---|
| The functions became plain handlers in `backend/api/`, deployed as Vercel serverless functions. `firebase-admin` authenticates with a service account key held only in Vercel's environment variables. | Spark cannot deploy Cloud Functions. The key never touches the repo, and `.gitignore` blocks the usual key filenames as a backstop. |
| The `handleOccupancy` trigger is gone. `POST /api/occupancy` stores a reading and judges it in the same request. | Vercel has no Firestore triggers. |
| One `POST /api/cron` endpoint, called every minute by cron-job.org with a bearer secret. It reclaims every call and sweeps every 5th minute. | Vercel Hobby cron runs once a day at most. The sweep reads every running booking, so running it every minute would use too much of the read quota. |
| Replay protection moved from "one occupancy doc per reading" to "a reading must be newer than the room's last one". | The same guarantee for replays, with one write per reading instead of two, and no sensor history stored. |
| Edge heartbeat 60s → 5 min; offline threshold 3 → 12 min. State changes are still sent immediately. | At 60s with a doc per reading, a room cost about 4,300 writes a day, which is 4–5 rooms on the free tier. Now it is about 290 writes and 860 reads a day, which fits about 35 rooms. The budget is worked out in the README. |
| The local dev server (`npm run dev` / `npm run demo`) serves the same `api/` files against the emulators and runs the cron jobs itself. | The demo still needs no accounts at all. |

I found one bug along the way. `preferRest` (REST instead of gRPC, for faster
cold starts) makes the Admin SDK ignore `FIRESTORE_EMULATOR_HOST` and look for
real credentials. Production uses REST; the emulator keeps gRPC.

## Where it stands

| Layer | State | Done |
|---|---|---|
| Edge capture | Recovers from camera disconnects | 85% |
| Presence detection | Works on my webcam; needs data from real rooms | 70% |
| Edge transport | HMAC, offline queue, dead-letter, replay-safe | 90% |
| Backend ingest | Signature, freshness, replay, unknown-room checks | 95% |
| Judging | Event-driven plus scheduled sweep | 90% |
| Warn / confirm | Backend-driven, token-authenticated | 80% |
| Room reclaim | Cancels, frees, records energy | 90% |
| Energy | Estimated from rated draw, not metered; no real switching | 60% |
| Bookings | API, form, seed script; no calendar integration | 70% |
| Dashboard | Auth, live state, demo panel | 85% |
| Tests / CI | Emulator + pytest suites (including the HTTP endpoints), Actions workflow | 85% |

About **80% of an MVP**, up from roughly 45% after round 1 and 25% at the start.

## Known limitations

- **One warning per booking.** If an owner confirms and then leaves for the rest
  of the slot, the room is not re-checked. Fix: allow a new warning once the
  previous one is older than the grace period.
- **Free-tier ceiling.** About 35 rooms on Firestore's Spark quota with
  two dashboards open. Vercel Hobby's 4 hours of Active CPU a month is the
  number to watch after the first real day. Hobby is also non-commercial
  only, so a paying customer means Vercel Pro.
- **The REST transport is untested.** Production talks to Firestore over
  REST, but the emulator suite has to use gRPC, so the first real deploy is
  the first run of that path.
- **Push needs a client.** The backend sends FCM to `users/{uid}.fcmToken`, but
  nothing registers a token yet. Warnings show in the dashboard's "My bookings"
  instead. A small PWA with a service worker would close this.
- **One shared HMAC secret.** Every device signs with the same key, so a stolen
  device could sign for any room. Per-device keys, bound to a room in Firestore,
  are the fix.
- **Energy is estimated.** The figure is rated power × time released. Measuring
  it needs a smart plug or a BMS integration.
- **The accuracy number is from one room.** [`BENCHMARK.md`](BENCHMARK.md) is a
  single laptop webcam. I need a false-positive rate over a few hundred frames
  from real classrooms before I would trust enforcement on real people.

## Open questions beyond the code

**Why a camera at all?** A mmWave presence sensor costs about $10 and needs no
model and no privacy conversation. My answers: it can reuse cameras that are
already installed, it needs no new wiring, and it can extend to headcount. I
still need to test those answers with someone who runs a campus.

**Calendars.** No one manages rooms in a bare Firestore collection. Google
Calendar and Outlook integration matters more for adoption than any defect
above.

**Cost per room.** A Pi 4, camera, enclosure and PoE come to about ₹6,000–8,000.
At 4.3 kW × 3 h/day × ₹8/kWh that pays back in a few months. That calculation
should be front and centre, with real tariffs.

**Compliance.** Cameras in Indian classrooms fall under the DPDP Act 2023. I
need signage, a written retention policy (zero retention is a real advantage
here), and a DPIA before any live pilot.
