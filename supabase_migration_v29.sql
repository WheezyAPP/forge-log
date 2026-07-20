-- Forge Log migration v29
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds push_subscriptions — one row per subscribed device (a person
-- could have a phone and a desktop both subscribed, so this is
-- deliberately not one-row-per-user). Stores the browser's push
-- endpoint + encryption keys (standard Web Push subscription shape)
-- plus the device's IANA timezone, captured once at subscribe time, so
-- the notification scheduler can convert each person's local-time rules
-- ("4am", "9am-10pm") into the right real moment for THEM specifically,
-- not a single server-wide time.
--
-- Safe to run — only adds a new table, doesn't touch existing data.

create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  timezone     text not null default 'UTC',
  created_at   timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx on push_subscriptions(user_id);

-- Tracks the last time each notification category was sent to a user,
-- per calendar date (in THEIR timezone) — this is what stops the
-- scheduler from re-firing the same reminder every time it runs. Water
-- and food check "has enough time passed since last_sent_at" (their
-- reset-on-log behavior); weight's two checkpoints just check "does a
-- row already exist for today" since each only ever fires once.
create table if not exists notification_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  category      text not null, -- 'water' | 'weight_4am' | 'weight_10am' | 'food'
  date          date not null,
  last_sent_at  timestamptz not null default now(),
  unique (user_id, category, date)
);
