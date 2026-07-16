-- ============================================================
-- Forge Log — complete schema (current as of migration v9)
-- ============================================================
-- FRESH INSTALL: paste this whole file into Supabase
-- (Dashboard -> SQL Editor -> New query -> Run). This one file
-- creates everything — you do NOT need any of the
-- supabase_migration_v*.sql files.
--
-- EXISTING DATABASE: do NOT run this file. Instead run only the
-- migration files newer than what you've already applied (they're
-- all idempotent / safe to re-run). See README "Upgrading".
-- ============================================================

-- ── Users & profiles ────────────────────────────────────────

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  avatar_data text,
  created_at  timestamptz not null default now()
);

create table if not exists profiles (
  user_id                uuid primary key references users(id) on delete cascade,
  gender                 text not null default 'male',
  age                    numeric not null default 26,
  height_in              numeric not null default 70,
  activity_idx           integer not null default 1,
  goal_type              text not null default 'lose',
  goal_rate_lbs_per_week numeric not null default 1,
  goal_weight_lbs        numeric,
  water_goal_oz          numeric,
  mini_cut_started_on    date,
  goal_started_on        date,
  adaptive_tdee          numeric,
  adaptive_tdee_set_on   date,
  use_adaptive_body_fat  boolean not null default false,
  show_body_fat_pct      boolean,
  creatine_already_saturated boolean not null default false,
  updated_at             timestamptz not null default now()
);

-- ── Daily entries (one row per user per date) ───────────────

create table if not exists entries (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  date               date not null,
  weight             numeric,
  calories_consumed  numeric,
  protein            numeric,
  carbs              numeric,
  fat                numeric,
  creatine           numeric,
  sleep_hours        numeric,
  sleep_quality      integer,
  body_fat_pct       numeric,
  fat_lbs            numeric,
  suggested_calories numeric,
  meals              jsonb not null default '[]'::jsonb,
  measurements       jsonb not null default '{}'::jsonb,
  weigh_ins          jsonb not null default '[]'::jsonb,
  water_logs         jsonb not null default '[]'::jsonb,
  updated_at         timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists entries_user_date_idx on entries (user_id, date);

-- ── Progressive-overload workout log ────────────────────────

create table if not exists workout_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  date         date not null,
  exercise     text not null,
  muscle_group text not null,
  sets         jsonb not null default '[]'::jsonb,
  split_id     text,
  created_at   timestamptz not null default now()
);

create index if not exists workout_sessions_user_date_idx     on workout_sessions (user_id, date);
create index if not exists workout_sessions_user_exercise_idx on workout_sessions (user_id, exercise);

-- ── Lifting split selection (Daily Lifting Schedule) ────────

create table if not exists user_splits (
  user_id           uuid primary key references users(id) on delete cascade,
  split_id          text,  -- nullable: weak_point_groups can be saved before a split is fully chosen
  split_started_on  date,
  weak_point_groups jsonb not null default '[]'::jsonb,
  updated_at        timestamptz not null default now()
);

-- ── Saved meal presets (one-tap Food Log combos) ────────────

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

-- ── Community food database (shared across all users) ────────
-- Separate from meal_presets, which is personal to one user. Anyone can
-- contribute a food here — via the Food Log's "Add to shared database"
-- button, or a barcode scan the USDA database didn't have — and it
-- becomes searchable for every user from then on. Stored per-100g, same
-- shape as USDA search results.

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

-- ── Row Level Security ──────────────────────────────────────

alter table users            enable row level security;
alter table profiles         enable row level security;
alter table entries          enable row level security;
alter table workout_sessions enable row level security;
alter table user_splits      enable row level security;
alter table meal_presets     enable row level security;
alter table community_foods  enable row level security;

drop policy if exists "public read users"   on users;
drop policy if exists "public insert users" on users;
drop policy if exists "public update users" on users;
create policy "public read users"   on users for select using (true);
create policy "public insert users" on users for insert with check (true);
create policy "public update users" on users for update using (true) with check (true);

drop policy if exists "public all profiles" on profiles;
create policy "public all profiles" on profiles for all using (true) with check (true);

drop policy if exists "public all entries" on entries;
create policy "public all entries" on entries for all using (true) with check (true);

drop policy if exists "public all workout_sessions" on workout_sessions;
create policy "public all workout_sessions" on workout_sessions for all using (true) with check (true);

drop policy if exists "public all user_splits" on user_splits;
create policy "public all user_splits" on user_splits for all using (true) with check (true);

drop policy if exists "public all meal_presets" on meal_presets;
create policy "public all meal_presets" on meal_presets for all using (true) with check (true);

drop policy if exists "public all community_foods" on community_foods;
create policy "public all community_foods" on community_foods for all using (true) with check (true);

-- ── Realtime (Partner Training live sync) ─────────────────────
alter publication supabase_realtime add table workout_sessions;
