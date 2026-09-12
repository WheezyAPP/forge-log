-- v36: health_metrics / health_sync_tokens — receives synced wearable
-- data (Google Health app / Fitbit Air, or any other source that can
-- POST to a webhook) rather than pulling it live via OAuth. Chosen over
-- a full Google Health API OAuth integration for now since it needs no
-- Google Cloud project, no token refresh logic, no backend beyond one
-- serverless function — just a URL to paste into a Health Connect
-- bridge app (or anything else capable of a scheduled POST).
--
-- Each user gets their own token (health_sync_tokens) rather than one
-- shared secret, since this is a multi-profile app — the token in the
-- sync URL is what tells api/health-sync.js whose data it's receiving.

create table if not exists health_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  date date not null,
  resting_heart_rate numeric,
  sleep_score numeric,
  sleep_duration_minutes numeric,
  steps numeric,
  active_zone_minutes numeric,
  hrv numeric,
  source text default 'google_health',
  synced_at timestamptz default now(),
  unique(user_id, date)
);

create table if not exists health_sync_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) unique,
  token text not null unique,
  created_at timestamptz default now()
);

create index if not exists idx_health_metrics_user_date on health_metrics(user_id, date);

alter table health_metrics enable row level security;
alter table health_sync_tokens enable row level security;
create policy "public all health_metrics" on health_metrics for all using (true) with check (true);
create policy "public all health_sync_tokens" on health_sync_tokens for all using (true) with check (true);
