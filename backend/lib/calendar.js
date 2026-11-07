// backend/lib/calendar.js
// Two-way Calendar Integration: RFC 5545 iCalendar (.ics) generation,
// external calendar webhook parser, and cancellation event dispatch.

/**
 * Format a Date object into iCalendar UTC timestamp: YYYYMMDDTHHMMSSZ
 */
function formatIcsDate(date) {
  const d = new Date(date);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Generate a standard RFC 5545 iCalendar feed for a room's active and upcoming bookings.
 * Compatible with Google Calendar, Microsoft Outlook, and Apple Calendar subscription URLs.
 * @param {Object} options
 * @param {Object} options.room - Room object ({ id, name, capacity })
 * @param {Array} options.bookings - List of booking objects ({ id, startTime, endTime, status, userId })
 */
function generateIcsFeed({ room, bookings = [], calendarName }) {
  const title = calendarName || `${(room && room.name) || (room && room.id) || 'Room'} Schedule`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ghost Resource Buster//Campus Room Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${title}`,
    'X-WR-TIMEZONE:UTC',
  ];

  for (const b of bookings) {
    const start = b.startTime && b.startTime.toDate ? b.startTime.toDate() : new Date(b.startTime);
    const end = b.endTime && b.endTime.toDate ? b.endTime.toDate() : new Date(b.endTime);
    const created = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : new Date();
    const isCancelled = b.status === 'canceled';

    lines.push(
      'BEGIN:VEVENT',
      `UID:ghost-booking-${b.id}@ghost-resource-buster`,
      `DTSTAMP:${formatIcsDate(new Date())}`,
      `DTSTART:${formatIcsDate(start)}`,
      `DTEND:${formatIcsDate(end)}`,
      `CREATED:${formatIcsDate(created)}`,
      `SUMMARY:${(room && room.name) || b.roomId} Reserved`,
      `DESCRIPTION:Managed by Ghost Resource Buster. Privacy-first occupancy enforcement.`,
      `LOCATION:${(room && room.name) || b.roomId}`,
      `STATUS:${isCancelled ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate an RFC 5545 cancellation event payload for an external calendar.
 */
function buildCancellationIcs(booking, room) {
  const start = booking.startTime && booking.startTime.toDate ? booking.startTime.toDate() : new Date(booking.startTime);
  const end = booking.endTime && booking.endTime.toDate ? booking.endTime.toDate() : new Date(booking.endTime);
  const now = new Date();

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ghost Resource Buster//Room Calendar//EN',
    'METHOD:CANCEL',
    'BEGIN:VEVENT',
    `UID:ghost-booking-${booking.id}@ghost-resource-buster`,
    `DTSTAMP:${formatIcsDate(now)}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:CANCELED: ${(room && room.name) || booking.roomId}`,
    `STATUS:CANCELLED`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

/**
 * Parse an incoming event from Google Calendar / Microsoft Graph webhook into Ghost booking params.
 */
function parseExternalBookingPayload(body) {
  if (!body) return null;
  const roomId = body.roomId || body.room_id || body.location;
  const startRaw = body.startTime || body.start?.dateTime || body.start;
  const endRaw = body.endTime || body.end?.dateTime || body.end;

  if (!roomId || !startRaw || !endRaw) return null;

  const start = new Date(startRaw);
  const end = new Date(endRaw);
  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);

  return {
    roomId: String(roomId).trim(),
    startTime: start.toISOString(),
    durationMinutes,
    externalId: body.id || body.eventId || null,
    source: body.source || 'external_calendar',
  };
}

module.exports = {
  formatIcsDate,
  generateIcsFeed,
  buildCancellationIcs,
  parseExternalBookingPayload,
};
