// Lightweight offline write queue. When a write to Supabase fails — no
// network, or the browser is simply offline — the operation gets stored
// here instead of silently dying, and gets replayed in order once
// connectivity returns. This is what stops "logged a weigh-in at the gym
// with no signal" from just quietly losing that entry.

const QUEUE_KEY = "forge_offline_queue";
const listeners = new Set();
const errorListeners = new Set();

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {}
  notify();
}

function notify() {
  const size = readQueue().length;
  listeners.forEach((fn) => fn(size));
}

function notifyError(info) {
  errorListeners.forEach((fn) => fn(info));
}

// Subscribe to queue-size changes (used by the offline banner UI).
// Returns an unsubscribe function. Fires immediately with the current size.
export function onQueueChange(fn) {
  listeners.add(fn);
  fn(readQueue().length);
  return () => listeners.delete(fn);
}

// Subscribe to sync failures that aren't just "we're offline" — i.e. the
// browser is online but a queued write keeps failing (bad data, RLS,
// a paused/misconfigured Supabase project, etc). Fires with
// { type, message } or null once the queue starts making progress again.
// This is what lets the UI explain *why* syncing looks stuck instead of
// spinning forever with no explanation.
export function onQueueError(fn) {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}

export function getQueueSize() {
  return readQueue().length;
}

// Escape hatch for a genuinely stuck queue (e.g. an op that will never
// succeed — references something since deleted, malformed data, etc).
// Each op's own local cache write already happened at save time, so the
// data you're looking at right now isn't lost — this only abandons the
// attempt to sync these specific writes to the database.
export function clearQueue() {
  writeQueue([]);
  notifyError(null);
}

export function isOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

// type: a string key matched against the `executors` map passed to flushQueue.
// args: plain-serializable array of arguments to replay the call with.
export function enqueueOp(type, args) {
  const queue = readQueue();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    args,
    ts: Date.now(),
  });
  writeQueue(queue);
}

let flushing = false;

// executors: { [type]: async (...args) => void }
// Replays queued operations oldest-first. Stops at the first failure so
// ordering is preserved and a still-down connection doesn't get hammered —
// the next 'online' event or timer tick will pick back up from there.
// Genuine failures (browser online, but the write itself failed) are
// logged and surfaced via onQueueError instead of swallowed, since a
// silent failure here is exactly what makes "stuck syncing" undebuggable.
export async function flushQueue(executors) {
  if (flushing) return;
  if (!isOnline()) return;
  flushing = true;
  try {
    let queue = readQueue();
    let madeProgress = false;
    while (queue.length > 0) {
      const op = queue[0];
      const fn = executors[op.type];
      if (!fn) {
        // Unknown op type (e.g. queued by an older app version) — drop it
        // rather than block the whole queue forever.
        queue = queue.slice(1);
        writeQueue(queue);
        continue;
      }
      try {
        await fn(...op.args);
        queue = queue.slice(1);
        writeQueue(queue);
        madeProgress = true;
      } catch (e) {
        console.error(`Sync failed for queued "${op.type}", will retry:`, e);
        notifyError({ type: op.type, message: e?.message || String(e), ts: Date.now() });
        break; // still failing — stop and retry later, don't hammer it
      }
    }
    if (madeProgress && queue.length === 0) notifyError(null);
  } finally {
    flushing = false;
  }
}
