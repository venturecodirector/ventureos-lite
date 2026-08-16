// Service worker for PWA installability and Web Push (playbook-v2 P6/1).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push with a body we cannot parse is still worth showing as something.
  }
  const title = data.title || "Venture OS";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // The deep link travels with the payload, so a tap lands on the entity
      // rather than on a hardcoded screen (it used to always open /calls).
      data: { href: data.href || "/" },
      // Same tag collapses repeats of one kind rather than stacking them.
      tag: data.tag || undefined,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || "/";
  event.waitUntil(
    // Focus an existing tab if the app is already open; only open a new one if
    // it is not. Two tabs of the same app is not what a tap asked for.
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(href);
          return client.focus();
        }
      }
      return self.clients.openWindow(href);
    }),
  );
});
