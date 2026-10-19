// functions/lib/firebase.js
// Single shared Firebase Admin initialisation.
//
// Cloud Functions loads every exported module into the same Node process,
// and initialising the default app twice throws. Every module imports the
// db and helpers from here instead of initialising its own.

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

module.exports = { db, FieldValue, Timestamp, getAuth, getMessaging };
