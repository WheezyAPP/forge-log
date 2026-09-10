-- v34: split_shares — sharing a saved custom split (7 or 30-day
-- template) with another user. Two paths:
--   - forced shares skip this table entirely, writing straight into the
--     recipient's own custom_split_templates (see storage.js
--     shareSplitTemplate).
--   - non-forced shares land here as status='pending' until the
--     recipient accepts (-> copied into their custom_split_templates,
--     status set to 'accepted') or declines (status='declined').

create table if not exists split_shares (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references users(id),
  to_user_id uuid not null references users(id),
  from_name text,
  name text not null,
  days jsonb not null default '[]',
  status text not null default 'pending',
  created_at timestamptz default now()
);

create index if not exists idx_split_shares_to_user_status on split_shares(to_user_id, status);
create index if not exists idx_split_shares_from_user on split_shares(from_user_id);

-- Matches every other table in this app: RLS on, fully permissive.
alter table split_shares enable row level security;
create policy "public all split_shares" on split_shares for all using (true) with check (true);
