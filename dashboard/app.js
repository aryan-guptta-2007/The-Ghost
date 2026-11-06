// dashboard/app.js
/*
  Admin dashboard and "My bookings" page.

  Firebase config comes from Hosting's reserved /__/firebase/init.json, so
  there are no keys to paste in. The backend API runs on Vercel; its URL is
  read from api-config.json. On localhost it talks to the emulators and the
  local dev server instead.

  Rendering: each listener writes into `state`, and render() updates one
  keyed card per room with textContent only. No per-room queries, no
  innerHTML with data in it.
*/

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  setDoc,
  updateDoc,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const EMULATOR_DEMO = { email: 'demo@ghost-buster.test', password: 'ghostdemo' };
const RECENT_RECLAIM_MS = 10 * 60 * 1000;
const LIVE_STATUSES = ['scheduled', 'active'];
const FIREBASE_MESSAGING = 'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------
// Without this config nothing else can run, so say so instead of showing a
// blank page.
const config = await fetch('/__/firebase/init.json')
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .catch((err) => {
    $('boot-error').textContent = 'The dashboard could not load its configuration. Check your connection and reload.';
    $('boot-error').hidden = false;
    throw err;
  });
const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app);
if (LOCAL) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// Where the API lives, and when a silent sensor counts as offline (must
// match GHOST_STALE_SECONDS on the backend; the local demo uses 180).
const apiConfig = LOCAL
  ? { apiBase: 'http://127.0.0.1:5100/api', staleSeconds: 180 }
  : await fetch('api-config.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const API_BASE = (apiConfig.apiBase || '').replace(/\/$/, '');
const STALE_MS = (apiConfig.staleSeconds || 720) * 1000;
// Web push certificate from Firebase console -> Cloud Messaging. Push stays
// off until it is set; warnings still show in "My bookings".
const VAPID_KEY = apiConfig.vapidKey || '';

async function api(path, body) {
  if (!API_BASE) throw new Error('Set apiBase in dashboard/api-config.json to your Vercel URL');
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const emptyState = () => ({
  rooms: new Map(),         // roomId -> room
  bookings: new Map(),      // bookingId -> active booking (staff)
  enforcement: new Map(),   // bookingId -> enforcement record (staff)
  confirmations: new Map(), // bookingId -> pending confirmation (staff)
  myWarnings: [],
  myBookings: [],
  stats: {},
  feed: [],
});
let state = emptyState();
let unsubscribers = [];
let staff = false;
let demoOnly = false; // the demo account can book demo rooms only

function listen(q, onData) {
  unsubscribers.push(
    onSnapshot(q, onData, (err) => {
      console.error(err);
      toast(`Live update failed: ${err.code || err.message}`);
    })
  );
}

const toMap = (snap) => new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));

function startListeners(uid) {
  listen(collection(db, 'rooms'), (s) => {
    state.rooms = toMap(s);
    renderRoomOptions();
    renderMyBookings(); // room names may arrive after the bookings do
    render();
  });
  listen(query(collection(db, 'confirmations'), where('userId', '==', uid), where('status', '==', 'pending')), (s) => {
    state.myWarnings = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderWarnings();
  });
  listen(query(collection(db, 'bookings'), where('userId', '==', uid), orderBy('startTime', 'desc'), limit(8)), (s) => {
    state.myBookings = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMyBookings();
  });

  if (!staff) return;
  listen(query(collection(db, 'bookings'), where('status', 'in', ['scheduled', 'active'])), (s) => {
    state.bookings = toMap(s);
    render();
  });
  listen(query(collection(db, 'enforcement'), orderBy('createdAt', 'desc'), limit(100)), (s) => {
    state.enforcement = toMap(s);
    render();
  });
  listen(query(collection(db, 'confirmations'), where('status', '==', 'pending')), (s) => {
    state.confirmations = toMap(s);
    render();
  });
  listen(doc(db, 'stats', 'global'), (s) => {
    state.stats = s.data() || {};
    renderStats();
  });
  listen(query(collection(db, 'decision_logs'), orderBy('timestamp', 'desc'), limit(15)), (s) => {
    state.feed = s.docs.map((d) => d.data());
    renderFeed();
  });
}

// ---------------------------------------------------------------------
// Room stage: what a viewer needs to know about each room right now
// ---------------------------------------------------------------------
const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const ago = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)} min ago`);

function activeBookingFor(roomId, now) {
  for (const b of state.bookings.values()) {
    if (b.roomId === roomId && b.startTime.toMillis() <= now && b.endTime.toMillis() > now) return b;
  }
  return null;
}

function stageFor(room, now) {
  const booking = activeBookingFor(room.id, now);
  const reading = room.lastReading;
  const silent = !reading || now - reading.timestamp.toMillis() > STALE_MS;

  if (!booking) {
    const reclaimed = room.lastReclaimAt && now - room.lastReclaimAt.toMillis() < RECENT_RECLAIM_MS;
    return reclaimed
      ? { tone: 'serious', icon: '↺', label: 'Reclaimed', detail: `Ghost booking released ${ago(now - room.lastReclaimAt.toMillis())}. Room is free.` }
      : { tone: 'idle', icon: '○', label: 'Free', detail: 'No booking right now' };
  }

  const enf = state.enforcement.get(booking.id);
  const conf = state.confirmations.get(booking.id);
  const until = `Booked until ${booking.endTime.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  if (enf && enf.status === 'warned' && conf) {
    return { tone: 'warning', icon: '!', label: 'Owner warned', detail: `${enf.reason}. Released in ${clock(conf.expiresAt.toMillis() - now)} unless confirmed.` };
  }
  if (enf && enf.status === 'confirmed') return { tone: 'good', icon: '✓', label: 'Owner confirmed', detail: until };
  if (enf && enf.status === 'cleared') return { tone: 'good', icon: '●', label: 'In use', detail: `Person detected after warning. ${until}` };

  const grace = booking.graceSeconds ?? 600;
  const graceLeft = booking.startTime.toMillis() + grace * 1000 - now;
  if (graceLeft > 0) return { tone: 'info', icon: '◷', label: 'Grace period', detail: `${clock(graceLeft)} for the owner to arrive` };
  if (!silent && reading.humanPresent) return { tone: 'good', icon: '●', label: 'In use', detail: until };
  return { tone: 'warning', icon: '?', label: 'Booked, looks empty', detail: 'Checked on the next sensor reading or sweep' };
}

function readingText(room, now) {
  const r = room.lastReading;
  if (!r) return 'Sensor: never reported';
  const age = now - r.timestamp.toMillis();
  if (age > STALE_MS) return `Sensor: silent for ${Math.round(age / 60_000)} min`;
  const source = r.source === 'demo' ? ' (demo)' : '';
  return `Sensor: ${r.humanPresent ? 'person present' : 'empty'}${source}, ${ago(age)}`;
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
const cards = new Map(); // roomId -> { li, parts }

function buildCard(room) {
  const li = el('li', 'room');
  const head = el('div', 'room-head');
  const titles = el('div');
  const name = el('div', 'room-name');
  const meta = el('div', 'room-meta');
  titles.append(name, meta);
  head.append(titles);

  const stage = el('div', 'stage');
  const icon = el('span', 'stage-icon');
  icon.setAttribute('aria-hidden', 'true');
  const label = el('span');
  stage.append(icon, label);

  const detail = el('div', 'stage-detail');
  const reading = el('div', 'reading');
  li.append(head, stage, detail, reading);

  if (room.demo) {
    const row = el('div', 'demo-row');
    for (const [action, text] of [['book', 'Book now'], ['vacant', 'Empty'], ['occupied', 'Occupied']]) {
      const b = el('button', '', text);
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api('demo', { roomId: room.id, action });
          toast(action === 'book' ? `Booked ${room.name} for you` : `${room.name} now reads ${text.toLowerCase()}`);
        } catch (err) {
          toast(err.message);
        } finally {
          b.disabled = false;
        }
      });
      row.append(b);
    }
    li.append(row);
  }
  return { li, parts: { name, meta, icon, label, detail, reading } };
}

function render() {
  if (!staff) return;
  const now = Date.now();
  const grid = $('room-grid');
  const ids = [...state.rooms.keys()].sort();

  for (const [id, card] of cards) {
    if (!state.rooms.has(id)) {
      card.li.remove();
      cards.delete(id);
    }
  }
  ids.forEach((id, i) => {
    const room = state.rooms.get(id);
    let card = cards.get(id);
    if (!card) {
      card = buildCard(room);
      cards.set(id, card);
    }
    if (grid.children[i] !== card.li) grid.insertBefore(card.li, grid.children[i] || null);

    const s = stageFor(room, now);
    const p = card.parts;
    card.li.dataset.tone = s.tone;
    p.name.textContent = room.name || id;
    p.meta.textContent = `${id} · ${room.capacity ?? '?'} seats · ${room.powerKw ?? 4.3} kW`;
    p.icon.textContent = s.icon;
    p.label.textContent = s.label;
    p.detail.textContent = s.detail;
    p.reading.textContent = readingText(room, now);
  });
  $('demo-hint').hidden = ![...state.rooms.values()].some((r) => r.demo);
}

function renderStats() {
  const s = state.stats;
  const kwh = s.energySavedKwh || 0;
  $('stat-energy').textContent = kwh < 100 ? kwh.toFixed(1) : Math.round(kwh).toLocaleString();
  $('stat-flagged').textContent = (s.ghostsFlagged || 0).toLocaleString();
  $('stat-reclaimed').textContent = (s.roomsReclaimed || 0).toLocaleString();
  $('stat-answered').textContent = ((s.warningsConfirmed || 0) + (s.warningsCleared || 0)).toLocaleString();
  const hours = (s.minutesReclaimed || 0) / 60;
  $('stat-hours').textContent = hours ? `${hours.toFixed(1)} room-hours freed` : '';
}

function renderFeed() {
  const list = $('feed');
  list.replaceChildren();
  if (!state.feed.length) {
    const li = el('li');
    li.append(el('span', 'empty', 'Nothing yet. Decisions appear here as the backend makes them.'));
    list.append(li);
    return;
  }
  for (const d of state.feed) {
    const li = el('li');
    const when = d.timestamp ? d.timestamp.toDate().toLocaleTimeString() : '…';
    li.append(el('time', '', when), el('span', 'what', `${d.decision}`), el('span', 'why', `${d.room_id}: ${d.reason}`));
    list.append(li);
  }
}

const warningCards = new Map(); // confirmationId -> { card, title, countdown }

function renderWarnings() {
  const box = $('my-warnings');
  const now = Date.now();
  // A warning stays pending until the next reclaim run even if its booking
  // has already ended, for example because the owner cancelled it.
  const warnings = state.myWarnings.filter((w) => {
    const booking = state.myBookings.find((b) => b.id === w.bookingId);
    return !booking || LIVE_STATUSES.includes(booking.status);
  });
  const live = new Set(warnings.map((w) => w.id));
  for (const [id, w] of warningCards) {
    if (!live.has(id)) {
      w.card.remove();
      warningCards.delete(id);
    }
  }
  for (const w of warnings) {
    if (!warningCards.has(w.id)) warningCards.set(w.id, buildWarning(w, box));
    const parts = warningCards.get(w.id);
    const room = state.rooms.get(w.roomId);
    const left = w.expiresAt.toMillis() - now;
    parts.title.textContent = `Your booking for ${room ? room.name : w.roomId} looks empty`;
    parts.countdown.textContent = left > 0
      ? `It will be released in ${clock(left)} unless you confirm you are there.`
      : 'Time is up. This booking is being released.';
    if (left <= 0) parts.btn.disabled = true; // the API would answer 410
  }
}

function buildWarning(w, box) {
  const card = el('div', 'warning-card');
  const text = el('div');
  const title = el('strong');
  const countdown = el('span');
  text.append(title, countdown);
  const btn = el('button', 'primary', "I'm here");
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api('confirm', { confirmationId: w.id });
      toast('Confirmed. Your booking is kept.');
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
  card.append(text, btn);
  box.append(card);
  return { card, title, countdown, btn };
}

function renderMyBookings() {
  const list = $('my-bookings');
  list.replaceChildren();
  if (!state.myBookings.length) {
    list.append(el('li', 'empty', 'No bookings yet.'));
    return;
  }
  const now = Date.now();
  for (const b of state.myBookings) {
    const room = state.rooms.get(b.roomId);
    const li = el('li');
    const info = el('div');
    const start = b.startTime.toDate();
    const end = b.endTime.toDate();
    const when = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const running = LIVE_STATUSES.includes(b.status) && b.endTime.toMillis() > now;
    const ended = LIVE_STATUSES.includes(b.status) && !running; // waiting for the next sweep
    const status = b.cancelReason === 'ghost_reclaimed' ? 'released (no one showed up)' : ended ? 'completed' : b.status;
    info.append(el('div', '', room ? room.name : b.roomId), el('div', 'sub', `${when} · ${status}`));
    li.append(info);
    if (running) {
      const cancel = el('button', 'ghost-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        try {
          await updateDoc(doc(db, 'bookings', b.id), { status: 'canceled' });
        } catch (err) {
          toast(err.message);
          cancel.disabled = false;
        }
      });
      li.append(cancel);
    }
    list.append(li);
  }
}

function renderRoomOptions() {
  const select = $('book-room');
  const current = select.value;
  select.replaceChildren(
    ...[...state.rooms.values()]
      .filter((r) => r.demo || !demoOnly)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => {
        const o = el('option', '', r.name || r.id);
        o.value = r.id;
        return o;
      })
  );
  if (current) select.value = current;
}

// ---------------------------------------------------------------------
// Forms and auth
// ---------------------------------------------------------------------
function defaultStart() {
  const d = new Date(Date.now() + 15 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

$('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('book-error').textContent = '';
  const button = e.submitter;
  button.disabled = true;
  try {
    await api('bookings', {
      roomId: $('book-room').value,
      startTime: new Date($('book-start').value).toISOString(),
      durationMinutes: Number($('book-length').value),
    });
    toast('Booked.');
  } catch (err) {
    $('book-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await signInWithEmailAndPassword(auth, $('login-email').value, $('login-password').value);
  } catch (err) {
    $('login-error').textContent = err.code === 'auth/invalid-credential' ? 'Wrong email or password.' : err.message;
  }
});

$('forgot-password').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  $('login-error').textContent = '';
  if (!email) {
    $('login-error').textContent = 'Enter your email first.';
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (err) {
    // Only a malformed address is worth reporting. Saying "no such user"
    // would tell anyone which addresses have accounts.
    if (err.code === 'auth/invalid-email') {
      $('login-error').textContent = 'That email address does not look right.';
      return;
    }
    if (err.code !== 'auth/user-not-found') console.error(err);
  }
  toast('If that address has an account, a reset link is on its way.');
});

$('sign-out').addEventListener('click', () => signOut(auth));

// ---------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------
const pushAvailable = () => Boolean(VAPID_KEY) && 'serviceWorker' in navigator && 'Notification' in window;

/** Gets this browser's FCM token and stores it where the backend looks for it. */
async function registerForPush(uid) {
  const { getMessaging, getToken, isSupported } = await import(FIREBASE_MESSAGING);
  if (!(await isSupported())) throw new Error('This browser does not support push notifications');
  const serviceWorkerRegistration = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const fcmToken = await getToken(getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration });
  await setDoc(doc(db, 'users', uid), { fcmToken }, { merge: true });
}

$('enable-push').addEventListener('click', async () => {
  const button = $('enable-push');
  button.disabled = true;
  try {
    if ((await Notification.requestPermission()) !== 'granted') {
      toast('Notifications are blocked. Warnings will still appear here.');
      return;
    }
    await registerForPush(auth.currentUser.uid);
    button.hidden = true;
    toast('Notifications are on.');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

/** Offer push to people who have not answered yet; refresh the token for those who said yes. */
function setUpPush(user, claims) {
  // The demo login is shared, so a token on it would reach whoever used it last.
  const usable = pushAvailable() && !claims.demo;
  $('enable-push').hidden = !usable || Notification.permission !== 'default';
  if (usable && Notification.permission === 'granted') {
    registerForPush(user.uid).catch((err) => console.error('Push registration failed:', err));
  }
}

// The demo button appears on localhost (emulator account) or when the
// deployment ships a demo-login.json with a read-only demo account.
const demoLogin = LOCAL
  ? EMULATOR_DEMO
  : await fetch('demo-login.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (demoLogin) {
  $('demo-login').hidden = false;
  $('demo-login').addEventListener('click', () => {
    $('login-email').value = demoLogin.email;
    $('login-password').value = demoLogin.password;
    $('login-form').requestSubmit();
  });
}

let timers = [];
onAuthStateChanged(auth, async (user) => {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  timers.forEach(clearInterval);
  timers = [];
  cards.forEach((c) => c.li.remove());
  cards.clear();
  // Nothing from the previous user may survive into the next session.
  warningCards.forEach((w) => w.card.remove());
  warningCards.clear();
  state = emptyState();
  staff = false;
  demoOnly = false;
  $('my-bookings').replaceChildren();
  $('feed').replaceChildren();

  $('login-view').hidden = !!user;
  $('app-view').hidden = !user;
  $('who').hidden = !user;
  if (!user) return;

  const { claims } = await user.getIdTokenResult();
  staff = claims.admin === true || claims.demo === true;
  demoOnly = claims.demo === true && claims.admin !== true;
  $('who-email').textContent = user.email;
  $('who-role').textContent = claims.admin ? 'admin' : claims.demo ? 'demo' : 'member';
  $('staff').hidden = !staff;
  $('book-start').value = defaultStart();
  setUpPush(user, claims);

  startListeners(user.uid);
  // Countdowns tick every second without waiting for a snapshot.
  timers.push(setInterval(() => (render(), renderWarnings()), 1000));
});
