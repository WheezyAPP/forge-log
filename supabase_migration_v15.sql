-- Forge Log migration v15
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds split_id to workout_sessions — records which split was actually
-- locked in when a session was logged. Fixes a real bug: switching
-- splits made the Schedule view relabel old sessions (logged under a
-- previous split) as if they belonged to the newly selected split's
-- days — e.g. a day that should read "Rest Day" under the new split
-- showing a stale "5 exercises logged" from the split you switched away
-- from. Existing sessions logged before this migration have no way to
-- know which split they belonged to, so they're left null — the
-- Schedule view treats that as "not part of the current split" rather
-- than guessing, but History and Trends still show them regardless,
-- since exercise progression tracking isn't split-specific.
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table workout_sessions
  add column if not exists split_id text;
