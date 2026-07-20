// Client-side push notification subscribe/unsubscribe flow. Kept
// separate from storage.js since this talks to the browser's own
// PushManager API, not just Supabase — storage.js still owns the actual
// save/delete calls to the push_subscriptions table.

import { savePushSubscription, deletePushSubscriptionByEndpoint } from "./storage";

// Web Push wants the VAPID public key as a raw Uint8Array, but env vars
// (and everything else about the key) are handled as base64url text —
// this is the standard conversion between the two.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function pushNotificationsSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

// Returns the browser's current subscription for this device, if any —
// used to show accurate on/off state in Settings without needing to ask
// the server (a subscription living in the browser but never reaching
// Supabase, e.g. from a failed save, would otherwise look "on" when it
// isn't really tracked).
export async function getCurrentPushSubscription() {
  if (!pushNotificationsSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Requests notification permission, subscribes this device, and saves
// the subscription. Returns { ok: true } or { ok: false, reason } — the
// caller decides how to surface a failure, since "permission denied" and
// "no VAPID key configured" call for different messaging.
export async function subscribeToPushNotifications(userId) {
  if (!pushNotificationsSupported()) return { ok: false, reason: "unsupported" };
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) return { ok: false, reason: "not-configured" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };

  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const json = subscription.toJSON();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const saved = await savePushSubscription(userId, {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    timezone,
  });
  if (!saved) return { ok: false, reason: "save-failed" };
  return { ok: true };
}

export async function unsubscribeFromPushNotifications() {
  const sub = await getCurrentPushSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await deletePushSubscriptionByEndpoint(endpoint);
}
