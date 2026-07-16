-- Forge Log migration v4
-- Run in Supabase SQL Editor if your tables already exist.
-- Adds user_splits (for the Daily Lifting Schedule feature).
-- Safe to run: only creates new things, touches nothing existing.

create table if not exists user_splits (
  user_id    uuid primary key references users(id) on delete cascade,
  split_id   text not null,
  updated_at timestamptz not null default now()
);

alter table user_splits enable row level security;

drop policy if exists "public all user_splits" on user_splits;
create policy "public all user_splits" on user_splits
  for all using (true) with check (true);
