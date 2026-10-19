// Shared setup for the scripts in this folder. Require it before anything
// that loads lib/firebase.js.
//
// Talks to the local emulators by default. Pass --project <id> to run
// against a real Firebase project; credentials then come from
// GOOGLE_APPLICATION_CREDENTIALS (a key file kept outside the repo) or
// FIREBASE_SERVICE_ACCOUNT.

const DEMO_PROJECT = 'demo-ghost-buster';
const LOCAL_API = 'http://127.0.0.1:5100/api';

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
// The API to call: --api <url>, GHOST_API_BASE, or the local dev server.
const apiBase = arg('api', process.env.GHOST_API_BASE || LOCAL_API).replace(/\/$/, '');

module.exports = { arg, useEmulators, projectId, apiBase, LOCAL_API };
