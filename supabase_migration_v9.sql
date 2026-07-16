-- Forge Log migration v9
-- Run in Supabase SQL Editor alongside your existing tables.
-- Adds meal_presets — a user's saved, named meal combos (e.g. "Protein
-- shake", "Usual breakfast") that can be added to the Food Log in one tap.
-- Safe to run — only creates a new table.

create table if not exists meal_presets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  name       text not null,
  calories   numeric not null default 0,
  protein    numeric not null default 0,
  carbs      numeric not null default 0,
  fat        numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists meal_presets_user_idx on meal_presets (user_id);

alter table meal_presets enable row level security;

drop policy if exists "public all meal_presets" on meal_presets;
create policy "public all meal_presets" on meal_presets
  for all using (true) with check (true);
