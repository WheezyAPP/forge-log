-- Forge Log migration v22
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds sleep_hours and sleep_quality to entries — sleep is one of the
-- biggest levers on recovery and directly relevant to why maintenance
-- calories or body composition might shift week to week, which makes it
-- a natural companion to what's already tracked. Scoped smaller than
-- water logging: one number per day rather than a full multi-entry
-- system, since most people think of sleep as "how did last night go,"
-- not something logged multiple times a day.
--
-- Safe to run — only adds columns, doesn't touch existing data.

alter table entries
  add column if not exists sleep_hours numeric,
  add column if not exists sleep_quality integer;
