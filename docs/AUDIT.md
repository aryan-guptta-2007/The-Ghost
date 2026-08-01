# Technical Audit — Ghost Resource Buster

A candid assessment of the codebase as submitted, the fixes applied, and what
remains before this is a product rather than a prototype.

**Verdict:** the architecture is sound and the backend skeleton is genuinely
well-reasoned. But the system could not run end to end. The single most
important thing — detecting whether a human is in the room — was never
implemented, and several files had never been executed even once.

---

## 1. What this project is

A system that reclaims **ghost bookings**: rooms reserved by someone who never
shows up. In a university with 60 classrooms, 15–25% of bookings are typically
no-shows, and each empty room keeps burning ~4.3 kW of AC and lighting.

The flow as designed:

```
Camera (edge device)
   -> detect human presence locally, discard the image
   -> POST signed {room, occupied?, confidence} to backend
        -> booking is active but room is empty past grace period?
             -> push notification: "confirm within 5 minutes"
                  -> confirmed  -> cancel enforcement, do nothing
                  -> ignored    -> cancel booking, free the room, cut power
```

The privacy design is the strongest idea here: no image ever leaves the room.
Only a boolean and a confidence score are transmitted. That is a real
differentiator and worth leading with.

---

## 2. Blocking defects found

Ranked by severity. Items marked **[FIXED]** are corrected in this repo.

### Critical — system could not function

| # | Defect | Impact |
|---|--------|--------|
| 1 | **No presence detection existed.** `orchestrator.py` computed `status = "occupied" if shape else "vacant"`. `shape` is a dimension tuple — always truthy. | Every room reported "occupied" forever. **No ghost booking could ever be detected.** The product had no product. **[FIXED]** — added `human_presence.py` |
| 2 | **`camera_capture.py` discarded every frame**, yielding only `(timestamp, id, shape)`. | Detection was impossible downstream even if written. **[FIXED]** |
| 3 | **`receiveOccupancy` endpoint never existed.** The edge device POSTed to it and signed every payload with HMAC. | Edge → backend chain fully broken; the HMAC signature was generated but verified nowhere. **[FIXED]** — added `receive_occupancy.js` |
| 4 | **`admin.initializeApp()` called in 5 separate files.** Cloud Functions loads all modules into one process. | Deploy crashes with *"The default Firebase app already exists"*. **[FIXED]** — single `lib/firebase.js` |
| 5 | **No barrel `index.js`.** Only `handleOccupancy` was exported. | `confirmAttendance`, `sendLateArrivalWarning`, `cancelUnconfirmedBookings` were written but **would never deploy**. **[FIXED]** |
| 6 | **Schema mismatch.** Edge sent `room_id` / `status:"occupied"` / float timestamp. Backend read `roomId` / `humanPresent:bool` / Firestore Timestamp. | Silent total failure at the boundary. **[FIXED]** — normalisation layer in `receive_occupancy.js` |
| 7 | **No `package.json`, `requirements.txt`, `firebase.json`, `firestore.rules`, or indexes.** | Nothing could be installed, deployed, or secured. **[FIXED]** |
| 8 | **`energy_controller.py` ended with a stray ` ``` ` markdown fence** (line 175). | File was not valid Python. Strong evidence it was never run. **[FIXED]** |

### High — runtime errors and security holes

| # | Defect | Impact |
|---|--------|--------|
| 9 | **Firestore transaction wrote before reading** in `cancel_unconfirmed_booking.js` (`tx.update` then `tx.get`). | Throws at runtime. Firestore mandates all reads before any writes. **[FIXED]** |
| 10 | **Non-transactional `.add()` inside a transaction** (`writeAuditLog`). Transactions retry on contention. | Duplicate audit entries — destroying the idempotency the comments claimed. **[FIXED]** — deterministic doc IDs |
| 11 | **`confirmAttendance` is an unauthenticated public HTTP endpoint.** The `userId` check only fires if the *caller* supplies it. | Anyone with a confirmationId can confirm someone else's attendance and defeat enforcement. **[OPEN — see §4]** |
| 12 | **No replay protection on HMAC.** No nonce, no freshness check. | A captured "occupied" payload could be replayed indefinitely to keep a ghost booking alive. **[PARTIALLY FIXED]** — 5-minute freshness window added; nonce still needed |
| 13 | **Firestore query with range filters on two different fields** (`startTime <=` and `endTime >=`) in `handleOccupancy`. | Query rejected by Firestore. **[OPEN — see §4]** |
| 14 | **Enforcement is event-driven, not time-driven.** It only fires when an occupancy doc arrives. | If the edge device dies or the room is empty and sends nothing, **no enforcement ever happens** — the exact failure case the product exists to catch. **[OPEN — architectural, see §4]** |
| 15 | **Single-frame verdict, no debounce.** One bad frame flagged a real occupant as a ghost. | Unacceptable false-accusation rate. **[FIXED]** — N-of-M sliding window in `PresenceDetector` |
| 16 | **`time.sleep(backoff)` inside the capture loop.** | Froze all detection for up to 60s during network trouble. **[FIXED]** — wall-clock scheduled retries |
| 17 | **Payloads silently deleted after 5 attempts.** | Data loss with no audit trail. **[FIXED]** — dead-letter table |

### Medium — dashboard and data integrity

| # | Defect | Impact |
|---|--------|--------|
| 18 | **Energy card can never show a number.** `app.js` reads `audit_logs` where `type == 'energy_savings'`, field `wh`. `energy_controller.py` writes `event: 'energy_savings'`, field `saved_watt_hours`, to a *local file*. Three mismatches. | Always `0 kWh`. **[OPEN]** |
| 19 | **`energy_controller.py` is never called by anything.** No import, no invocation. | Dead code. The energy-saving claim is unsubstantiated. **[OPEN]** |
| 20 | **Dashboard has no authentication at all.** Firebase config placeholders + direct client Firestore reads. | An "admin" dashboard readable by the entire internet. **[MITIGATED]** by the new `firestore.rules`, but the login UI is still missing. |
| 21 | **N+1 query with a render race.** `list.innerHTML = ''` then async `.then()` appends per room. | Duplicated and out-of-order room cards on every snapshot. **[OPEN]** |
| 22 | **Energy savings arithmetic is wrong.** `_record_savings` measures the *active* period duration and reports it as idle savings. | Inverted metric — reports savings for time the room was occupied. **[OPEN]** |
| 23 | **No booking creation path exists.** The whole system assumes a `bookings` collection with no way to populate it. | Cannot be demoed end to end. **[OPEN]** |
| 24 | **Chain is broken between functions.** Nothing calls `sendLateArrivalWarning`. `handleOccupancy` writes `enforcement: pending` and stops. `decision_logger.js` is imported by nobody. | detect → warn → confirm → cancel has a missing middle. **[OPEN]** |
| 25 | **Zero tests, no CI, no README, no LICENSE.** | **[FIXED]** for docs/scaffolding; tests still needed. |

---

## 3. Completeness estimate

| Layer | State | Done |
|-------|-------|------|
| Edge capture | Working, hardened | 85% |
| Edge detection | Written from scratch, needs field tuning | 70% |
| Edge transport (HMAC, queue, retry) | Solid | 85% |
| Backend ingest | Written from scratch | 80% |
| Backend judging | Needs scheduled sweep + query fix | 45% |
| Notification / confirm loop | Chain incomplete, endpoint unauthenticated | 40% |
| Room reclaim | Now releases the room | 65% |
| Energy control | Mock only, never invoked, math inverted | 15% |
| Booking system | Does not exist | 0% |
| Admin dashboard | Renders, no auth, wrong queries | 30% |
| Tests / CI | None | 0% |

**Roughly 45% of a working MVP** after these fixes — up from about 25% as
submitted, where the system could not complete a single end-to-end cycle.

---

## 4. What to fix next, in order

**Week 1 — make one full cycle work**
1. Add a scheduled `sweepActiveBookings` function that runs every minute and
   checks *all* active bookings for missing/stale occupancy. This replaces
   event-driven enforcement and fixes defect #14 — the current design cannot
   detect the silence that ghost bookings actually produce.
2. Split the two-range-field query (#13): filter on `startTime <= now` in
   Firestore, then filter `endTime >= now` in memory.
3. Wire the chain: `handleOccupancy` writes enforcement → calls
   `sendLateArrivalWarning` → creates confirmation → scheduled cancel picks it up.
4. Require a Firebase ID token on `confirmAttendance` (#11) and verify the
   caller owns the booking.

**Week 2 — make it demonstrable**
5. Minimal booking API + a booking page. Without this there is nothing to demo.
6. Fix the energy metric collection/field names and the inverted arithmetic.
7. Add Firebase Auth to the dashboard and fix the N+1 render race.
8. Seed script that populates rooms and bookings for a live demo.

**Week 3 — make it credible**
9. Emulator-based integration tests: ghost path, confirm path, replay attack,
   device-offline path.
10. GitHub Actions CI running lint + tests.
11. Record accuracy numbers: false-positive rate over a few hundred real frames.
    A single measured number here is worth more than any amount of README prose.

---

## 5. Market gaps — the honest part

Engineering aside, these determine whether this is a product:

**The competitive threat is a $10 sensor.** A mmWave presence sensor detects
occupancy without a camera, without a Raspberry Pi, without an ML model, and
without a privacy conversation. Before building further, answer: *why a camera?*
There are good answers — headcount vs. binary presence, no new wiring, using
cameras already installed — but they must be stated and defended.

**Nobody manages rooms in a bare Firestore collection.** Real customers run
Google Calendar, Outlook, Robin, or an ERP like Blackbaud/Ellucian. Without a
calendar integration this can never be adopted, only demoed. This is a bigger
gap than any code defect listed above.

**Cost per room is unstated.** Pi 4 + camera + enclosure + PoE ≈ ₹6,000–8,000
per room. At 4.3 kW × 3 hours saved/day × ₹8/kWh, payback is a few months —
that arithmetic is your entire sales pitch and it is currently absent.

**Compliance is not optional in India.** Cameras in classrooms fall under the
DPDP Act 2023. You need signage, a stated retention policy (yours is "zero",
which is excellent), and a documented DPIA. Your metadata-only architecture is
a genuine legal advantage — but only if you write it down.

**Missing entirely:** multi-tenancy, roles, onboarding, pricing, hardware BOM,
and any measured accuracy figure.

---

## 6. How to present this on GitHub

Do not oversell. A README claiming a finished product invites a reviewer to
find defect #1 in ninety seconds; a README that says *"presence detection with
temporal debounce; scheduled enforcement sweep in progress"* reads as an
engineer who knows the state of their own system. The second is far more
impressive to anyone technical.

Lead with the architecture diagram and the privacy design. Keep a visible
"Current status" table with honest percentages. Ship the audit as a document —
finding twenty-five defects in your own code and fixing seventeen of them is a
stronger portfolio signal than the feature list ever was.
