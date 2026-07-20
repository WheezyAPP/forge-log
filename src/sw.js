// Custom service worker (injectManifest mode) — replaces the previously
// auto-generated one so this file can add its own `push` and
// `notificationclick` listeners, which generateSW mode has no way to
// support. Workbox still does the precaching/runtime-caching work below,
// just invoked explicitly instead of configured entirely from
// vite.config.js.

import { precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

// Precaches the built app shell (JS/CSS/HTML/icons) — injected at build
// time by the injectManifest plugin. Same effect as the old
// globPatterns config, just expressed as a real call now.
precacheAndRoute(self.__WB_MANIFEST);

// Supabase reads (GET requests) get cached so the last-known data is
// available offline too — falls back to cache if the network request
// takes longer than 5s or fails outright. Carried over unchanged from
// the previous generateSW config; this works alongside (not instead of)
// the app's own localStorage read cache in src/lib/storage.js.
registerRoute(
  ({ url }) => url.hostname.endsWith(".supabase.co") && url.pathname.includes("/rest/v1/"),
  new NetworkFirst({
    cacheName: "supabase-api-cache",
    networkTimeoutSeconds: 5,
    plugins: [
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// Fires when a push message actually arrives from the push service —
// the payload is whatever JSON the sender (api/send-notifications.js)
// put in it. `waitUntil` keeps the service worker alive until the
// notification is actually shown, since the browser can otherwise kill
// the worker mid-async-call.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Forge Log", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Forge Log";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Carries which tab to open on tap through to notificationclick
    // below — e.g. "/?tab=water" for a water reminder.
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Fires when the person taps the notification itself. Focuses an
// already-open tab and navigates it if one exists, otherwise opens a
// new one — either way landing on the specific tab the notification
// was about, not just the app's default screen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          if ("navigate" in client) client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
