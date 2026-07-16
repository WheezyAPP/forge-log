import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // We already maintain our own public/manifest.json (referenced
      // directly from index.html for the iOS "Add to Home Screen" flow),
      // so tell the plugin not to generate a second one.
      manifest: false,
      includeAssets: ["icon-192.png", "icon-512.png"],
      workbox: {
        // Precache the built app shell (JS/CSS/HTML/icons) so the app
        // itself loads with zero signal, not just a blank/failed page.
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        // Supabase reads (GET requests) get cached so the last-known data
        // is available offline too — falls back to cache if the network
        // request takes longer than 5s or fails outright. This works
        // alongside (not instead of) the app's own localStorage read
        // cache in src/lib/storage.js.
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.hostname.endsWith(".supabase.co") && url.pathname.includes("/rest/v1/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-api-cache",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
