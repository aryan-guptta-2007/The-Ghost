// functions/lib/firebase.js
// Single shared Firebase Admin initialisation.
//
// WHY THIS EXISTS:
// Cloud Functions loads every exported module into the SAME Node process.
// Calling admin.initializeApp() in more than one file throws
// "The default Firebase app already exists". Every function module must
// import the app/db from here instead of initialising its own.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

module.exports = { admin, db };
