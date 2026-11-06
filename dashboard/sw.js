// dashboard/sw.js
// Shows ghost warnings as notifications when no dashboard tab is open.
// Registered only after the user turns notifications on (see app.js).
// FCM delivers to the standard push event, so the Firebase SDK is not needed.

self.addEventListener('push', (event) => {
  const { notification = {}, data = {} } = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(notification.title || 'Ghost Resource Buster', {
      body: notification.body,
      icon: 'icon.svg',
      tag: data.bookingId,
      requireInteraction: true,
    })
  );
});

// Answering a warning needs a signed-in session, so a click opens the dashboard.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      const open = tabs.find((tab) => 'focus' in tab);
      return open ? open.focus() : self.clients.openWindow('./');
    })
  );
});
