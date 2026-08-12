// Minimal service worker for PWA installability + callback push (spec §4.17).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Web Push handler (used once VAPID/web-push is wired server-side).
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Venture OS", body: "Callback due" };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/calls"));
});
