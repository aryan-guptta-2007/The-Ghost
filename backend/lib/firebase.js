// backend/lib/firebase.js
// Single shared Firebase Admin initialisation.
//
// Credentials, in order:
//   1. FIREBASE_SERVICE_ACCOUNT  the service account key JSON, as one env var.
//      This is how production on Vercel authenticates. The key lives only in
//      Vercel's environment settings, never in the repo.
//   2. The emulators (FIRESTORE_EMULATOR_HOST set): no credentials needed.
//   3. Application default credentials, for running scripts by hand
//      (GOOGLE_APPLICATION_CREDENTIALS=/path/outside/the/repo/key.json).

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole key file as the value.');
  }
}

if (!getApps().length) {
  const account = serviceAccount();
  initializeApp(account ? { credential: cert(account), projectId: account.project_id } : undefined);
}

const usingEmulator = () => Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const db = getFirestore();
// In production, REST instead of gRPC for one-shot requests: much faster
// cold starts on serverless. The REST transport does not honour
// FIRESTORE_EMULATOR_HOST, so the emulator keeps the default gRPC transport.
if (!usingEmulator()) db.settings({ preferRest: true });

module.exports = { db, FieldValue, Timestamp, getAuth, getMessaging, usingEmulator };
