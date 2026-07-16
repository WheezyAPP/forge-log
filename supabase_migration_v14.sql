-- Forge Log migration v14
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds community_foods — a shared, cross-user food database, separate
-- from meal_presets (which is personal to one user). Anyone can
-- contribute an entry from the Food Log's "Add to shared database"
-- button, or from a barcode scan the USDA database didn't have, and it
-- becomes searchable for every user from then on. Stored per-100g, same
-- shape as USDA search results, so it works with the existing search
-- and serving-size UI without any special-casing.
--
-- Safe to run — only creates a new table.

create table if not exists community_foods (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  brand         text,
  cal100        numeric not null default 0,
  protein100    numeric not null default 0,
  carbs100      numeric not null default 0,
  fat100        numeric not null default 0,
  serving_g     numeric not null default 100,
  serving_label text,
  barcode       text,
  added_by      text,
  use_count     integer not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists community_foods_barcode_idx on community_foods (barcode);
create index if not exists community_foods_name_idx on community_foods (lower(name));

alter table community_foods enable row level security;

drop policy if exists "public all community_foods" on community_foods;
create policy "public all community_foods" on community_foods
  for all using (true) with check (true);
