-- Forge Log migration v21
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Enables Supabase Realtime on workout_sessions — required for true
-- live cross-device sync in Partner Training mode: when your partner
-- logs a set on their own phone, your screen updates without a manual
-- refresh. Without this, the table works exactly as before, just
-- without the live-update capability.
--
-- Safe to run — only changes replication settings, doesn't touch data.

alter publication supabase_realtime add table workout_sessions;
