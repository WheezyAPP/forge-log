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
      // injectManifest (not the default generateSW) — this app now needs
      // its own `push` and `notificationclick` event listeners for web
      // push notifications, which generateSW mode has no way to add
      // (it only ever produces a fully auto-generated service worker
      // from config, no room for custom handlers). injectManifest lets
      // src/sw.js be a real, hand-written service worker — Workbox still
      // handles precaching inside it, just via an explicit call instead
      // of owning the whole file.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      injectManifest: {
        // Same precache scope as before the switch — the app shell
        // (JS/CSS/HTML/icons) still gets cached so the app itself loads
        // with zero signal, not just a blank/failed page.
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
      },
    }),
  ],
});
