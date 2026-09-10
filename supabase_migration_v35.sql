-- v35: training_sessions / training_session_members — backs the
-- reworked "Train with a partner" flow. Host and Join are now two
-- distinct actions across potentially separate devices, not one
-- person driving both sides from a single phone:
--
--   - Hosting creates one training_sessions row. host_blocks holds the
--     host's live exercise queue ({exercise, grp, setCount}[]) and is
--     kept in sync with whatever the host is actually doing, broadcast
--     to every joined member over Realtime.
--   - Joining inserts one training_session_members row. Capped at 3
--     members per session client-side (host + 3 = 4 total). A
--     member's `overrides` map holds any exercise slots (keyed by
--     index into host_blocks) they've personally swapped away from
--     the host's pick — everything NOT in overrides stays locked to
--     and auto-updates with the host's list; a force-resync clears
--     overrides back to fully synced.

create table if not exists training_sessions (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid not null references users(id),
  host_blocks jsonb not null default '[]',
  status text not null default 'active', -- 'active' | 'ended'
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists training_session_members (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references training_sessions(id) on delete cascade,
  user_id uuid not null references users(id),
  overrides jsonb not null default '{}',
  joined_at timestamptz default now(),
  unique(session_id, user_id)
);

create index if not exists idx_training_sessions_status on training_sessions(status);
create index if not exists idx_training_sessions_host on training_sessions(host_user_id);
create index if not exists idx_training_session_members_session on training_session_members(session_id);
create index if not exists idx_training_session_members_user on training_session_members(user_id);

-- Both tables need to be in the Realtime publication or none of the
-- live sync (host_blocks broadcasting, join/leave, force-resync,
-- session-ended kick-out) actually fires — postgres_changes
-- subscriptions on a table outside this publication silently never
-- deliver anything, no error either side.
alter publication supabase_realtime add table training_sessions;
alter publication supabase_realtime add table training_session_members;

-- Matches every other table in this app: RLS on, fully permissive —
-- there's no per-user auth model here (shared-device profiles, not
-- Supabase Auth), so this is consistency/lint-cleanliness, not an
-- actual access restriction.
alter table training_sessions enable row level security;
alter table training_session_members enable row level security;
create policy "public all training_sessions" on training_sessions for all using (true) with check (true);
create policy "public all training_session_members" on training_session_members for all using (true) with check (true);

-- The client only checks the 4-total cap against a snapshot fetched
-- when the join list was opened — two people tapping "join" within
-- the same moment could both pass that stale check and both get
-- inserted, going over the cap. This closes it for real, at the one
-- place it can't be raced: the insert itself.
create or replace function enforce_training_session_cap()
returns trigger as $$
begin
  if (select count(*) from training_session_members where session_id = new.session_id) >= 3 then
    raise exception 'training session % is full (max 3 members)', new.session_id;
  end if;
  return new;
end;
$$ language plpgsql
set search_path = public, pg_temp;

drop trigger if exists trg_training_session_cap on training_session_members;
create trigger trg_training_session_cap
  before insert on training_session_members
  for each row execute function enforce_training_session_cap();

-- Atomic per-slot override merge — a client-side read-then-write
-- would race if a member swaps two exercises back to back (the
-- second write's read could land on a stale snapshot from before the
-- first write committed, silently dropping it). This does the jsonb
-- merge/delete in one UPDATE, no read step to race.
create or replace function set_training_member_override(p_session_id uuid, p_user_id uuid, p_index text, p_override jsonb)
returns void as $$
begin
  if p_override is null then
    update training_session_members
    set overrides = overrides - p_index
    where session_id = p_session_id and user_id = p_user_id;
  else
    update training_session_members
    set overrides = overrides || jsonb_build_object(p_index, p_override)
    where session_id = p_session_id and user_id = p_user_id;
  end if;
end;
$$ language plpgsql
set search_path = public, pg_temp;
