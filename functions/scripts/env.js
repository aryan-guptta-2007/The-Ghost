// Shared setup for the scripts in this folder.
//
// Talks to the local emulators by default. Pass --project <id> to run
// against a real Firebase project with your application-default
// credentials (gcloud auth application-default login).

const fs = require('fs');
const path = require('path');

const DEMO_PROJECT = 'demo-ghost-buster';
const SECRET_FILE = path.join(__dirname, '..', '.secret.local');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const project = arg('project');
const useEmulators = !project;

if (useEmulators) {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || DEMO_PROJECT;
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
} else {
  process.env.GCLOUD_PROJECT = project;
}

const projectId = process.env.GCLOUD_PROJECT;
const functionsBase = useEmulators
  ? `http://127.0.0.1:5001/${projectId}/us-central1`
  : `https://us-central1-${projectId}.cloudfunctions.net`;

/** The HMAC secret: env first, then functions/.secret.local (emulator). */
function hmacSecret() {
  if (process.env.GHOST_HMAC_SECRET) return process.env.GHOST_HMAC_SECRET;
  if (fs.existsSync(SECRET_FILE)) {
    const match = fs.readFileSync(SECRET_FILE, 'utf8').match(/^GHOST_HMAC_SECRET=(.+)$/m);
    if (match) return match[1].trim();
  }
  throw new Error('Set GHOST_HMAC_SECRET, or run `npm run demo` once to create functions/.secret.local');
}

module.exports = { arg, useEmulators, projectId, functionsBase, hmacSecret, SECRET_FILE };
