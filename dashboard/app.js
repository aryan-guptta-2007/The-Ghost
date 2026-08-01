// dashboard/app.js
/* Simple demo script for the admin dashboard.
   It connects to Firebase Firestore, listens to the relevant collections,
   and updates the three summary cards in real time.
   Replace the placeholder firebaseConfig with your project's credentials.
*/

// Initialize Firebase (replace with real config)
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// ---- Summary cards ---------------------------------------------------
function updateSummary() {
    // Ghost violations count (documents in enforcement where decision == 'abusive')
    db.collection('enforcement')
        .where('decision', '==', 'abusive')
        .onSnapshot((snap) => {
            document.getElementById('ghost-violations').textContent = snap.size;
        });

    // Reclaimed resources – count of enforcement docs that have been resolved/cancelled
    db.collection('enforcement')
        .where('status', 'in', ['resolved', 'canceled'])
        .onSnapshot((snap) => {
            document.getElementById('reclaimed-resources').textContent = snap.size;
        });

    // Energy savings – sum of kWh stored in audit_logs with type 'energy_savings'
    db.collection('audit_logs')
        .where('type', '==', 'energy_savings')
        .onSnapshot((snap) => {
            let totalWh = 0;
            snap.forEach((doc) => {
                const data = doc.data();
                totalWh += data.wh || 0; // assume field `wh` stores watt‑hours saved
            });
            const kwh = (totalWh / 1000).toFixed(2);
            document.getElementById('energy-kwh').textContent = `${kwh} kWh`;
        });
}

// ---- Room list ------------------------------------------------------
function renderRooms() {
    const list = document.getElementById('room-list');
    db.collection('rooms').onSnapshot((snap) => {
        list.innerHTML = '';
        snap.forEach((doc) => {
            const r = doc.data();
            const li = document.createElement('li');
            li.className = 'room-item';
            // Determine visual state based on latest occupancy entry
            db.collection('occupancy')
                .where('roomId', '==', r.roomId)
                .orderBy('timestamp', 'desc')
                .limit(1)
                .get()
                .then((occSnap) => {
                    if (!occSnap.empty) {
                        const occ = occSnap.docs[0].data();
                        if (!occ.humanPresent) {
                            li.classList.add('ghost');
                        } else {
                            li.classList.add('active');
                        }
                    } else {
                        li.classList.add('idle');
                    }
                    li.innerHTML = `<h3>${r.name}</h3><p>ID: ${r.roomId}</p>`;
                    list.appendChild(li);
                });
        });
    });
}

// Initialise UI
updateSummary();
renderRooms();
