// Lightweight global toast notifications — no dependency, matches the
// same pub/sub pattern as offlineQueue.js. Used so failed saves (which
// get silently queued for retry) still tell the user something didn't
// go through, instead of failing invisibly.

const listeners = new Set();
let nextId = 1;

export function onToastsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(toasts) {
  listeners.forEach((fn) => fn(toasts));
}

let toasts = [];

function push(toast) {
  const id = nextId++;
  const entry = { id, duration: 4000, ...toast };
  toasts = [...toasts, entry];
  notify(toasts);
  if (entry.duration) {
    setTimeout(() => dismiss(id), entry.duration);
  }
  return id;
}

export function dismiss(id) {
  toasts = toasts.filter((t) => t.id !== id);
  notify(toasts);
}

export function toastError(message) {
  return push({ kind: "error", message, duration: 5000 });
}

export function toastInfo(message, duration = 3000) {
  return push({ kind: "info", message, duration });
}

export function toastSuccess(message, duration = 2200) {
  return push({ kind: "success", message, duration });
}

// Longer duration than a plain success toast — 5s gives a real chance to
// hit Undo before it's gone, since accidentally tapping the wrong delete
// button in a scrollable list is an easy mistake to make.
export function toastUndo(message, action, duration = 5000) {
  return push({ kind: "success", message, duration, action });
}
