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
    failCount: 0,
  });
  writeQueue(queue);
}

let flushing = false;
// After this many consecutive failures on the SAME op, give up on it
// specifically rather than retrying forever. A transient issue (offline,
// Supabase project asleep, a momentary network blip) resolves within a
// few retries; anything still failing the same way after 5 attempts is
// something that will never succeed no matter how many more times it's
// retried — bad/malformed data, a reference to something since deleted,
// etc. Without this, one bad op blocks every op queued behind it
// forever, with no self-healing — "Discard queued changes" was the only
// way out, and only if someone actually finds and taps it.

const MAX_OP_RETRIES = 5;

// executors: { [type]: async (...args) => void }
// Replays queued operations oldest-first. Stops at the first failure so
// ordering is preserved and a still-down connection doesn't get hammered —
// the next 'online' event or timer tick will pick back up from there.
// Genuine failures (browser online, but the write itself failed) are
// logged and surfaced via onQueueError instead of swallowed, since a
// silent failure here is exactly what makes "stuck syncing" undebuggable.
// Removes one op by id from the CURRENT stored queue, not from a stale
// snapshot — see the note in flushQueue below for why that distinction
// is the whole point of these two helpers.
function removeOpById(id) {
  writeQueue(readQueue().filter(o => o.id !== id));
}

function updateOpById(id, patch) {
  writeQueue(readQueue().map(o => (o.id === id ? { ...o, ...patch } : o)));
}

export async function flushQueue(executors) {
  if (flushing) return;
  if (!isOnline()) return;
  flushing = true;
  try {
    let madeProgress = false;
    // Re-read from localStorage on EVERY iteration rather than holding a
    // snapshot across the awaits below. The old version read the queue
    // once, then did `queue = queue.slice(1); writeQueue(queue)` after
    // each `await fn(...)` — so any op enqueued DURING that await (a
    // failed save while online, which is exactly what enqueueOp is for)
    // got written to localStorage by enqueueOp and then immediately
    // overwritten by this stale array. The write vanished with no error
    // and no retry — silent data loss in the one file whose entire job
    // is preventing it.
    //
    // Same root cause as the overlapping-auto-save duplicate bug in
    // SplitDashboard (a stale in-memory view of state that something
    // else mutated mid-flight), and the same shape of fix: treat the
    // stored queue as the single source of truth and address ops by id
    // instead of by position.
    while (true) {
      const queue = readQueue();
      if (queue.length === 0) break;
      const op = queue[0];
      const fn = executors[op.type];
      if (!fn) {
        // Unknown op type (e.g. queued by an older app version) — drop it
        // rather than block the whole queue forever.
        removeOpById(op.id);
        continue;
      }
      try {
        await fn(...op.args);
        removeOpById(op.id);
        madeProgress = true;
      } catch (e) {
        const failCount = (op.failCount || 0) + 1;
        console.error(`Sync failed for queued "${op.type}" (attempt ${failCount}):`, e);
        if (failCount >= MAX_OP_RETRIES) {
          console.error(`Giving up on queued "${op.type}" after ${failCount} failed attempts — dropping it so the rest of the queue can proceed:`, op);
          removeOpById(op.id);
          notifyError({ type: op.type, message: `Gave up after ${failCount} attempts: ${e?.message || String(e)}`, dropped: true, ts: Date.now() });
          madeProgress = true;
          continue; // keep going — try the next op instead of stopping here
        }
        updateOpById(op.id, { failCount });
        notifyError({ type: op.type, message: e?.message || String(e), ts: Date.now() });
        break; // still within retry budget — stop and let it try again later
      }
    }
    if (madeProgress && readQueue().length === 0) notifyError(null);
  } finally {
    flushing = false;
  }
}
