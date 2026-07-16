-- Forge Log migration v11
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Fixes a real bug: user_splits.split_id was NOT NULL, but
-- setUserWeakPointGroups() upserts a row with only user_id and
-- weak_point_groups set. If that row didn't already exist (no prior
-- successful setUserSplitId write for that user), the upsert becomes
-- an INSERT missing split_id and Postgres rejects it — every retry,
-- forever, since it's the same violation each time. This is what a
-- permanently "stuck syncing" banner on a weak-point selection means.
--
-- Safe to run — only relaxes a constraint, doesn't touch existing data.

alter table user_splits alter column split_id drop not null;
