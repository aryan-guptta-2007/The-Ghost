// backend/api/calendar.js
// GET  /api/calendar?roomId=<id>  — Live RFC 5545 iCal schedule feed for Google Calendar / Outlook
// POST /api/calendar             — External calendar booking sync webhook

const { db, Timestamp } = require('../lib/firebase');
const { generateIcsFeed, parseExternalBookingPayload } = require('../lib/calendar');
const { createBookingLogic } = require('../create_booking');
const { verifyBearer } = require('../lib/auth');
const { allowedOrigins } = require('../lib/http');

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const roomId = url.searchParams.get('roomId') || (req.query && req.query.roomId);
      if (!roomId) {
        return res.status(400).json({ error: 'Missing roomId query parameter' });
      }

      const roomSnap = await db.collection('rooms').doc(roomId).get();
      if (!roomSnap.exists) {
        return res.status(404).json({ error: `Room ${roomId} not found` });
      }

      const now = Timestamp.now();
      const bookingsSnap = await db
        .collection('bookings')
        .where('roomId', '==', roomId)
        .where('status', 'in', ['scheduled', 'active'])
        .where('endTime', '>', now)
        .limit(50)
        .get();

      const bookings = bookingsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const icsContent = generateIcsFeed({ room: { id: roomId, ...roomSnap.data() }, bookings });

      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="${roomId}.ics"`);
      return res.status(200).send(icsContent);
    }

    if (req.method === 'POST') {
      const token = await verifyBearer(req);
      const parsed = parseExternalBookingPayload(req.body);
      if (!parsed) {
        return res.status(400).json({ error: 'Invalid calendar event payload' });
      }
      const result = await createBookingLogic(token.uid, parsed, { externalSync: true });
      return res.status(201).json(result);
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('calendar endpoint error:', err);
    return res.status(500).json({ error: 'Internal calendar error' });
  }
};
