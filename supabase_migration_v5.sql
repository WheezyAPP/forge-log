-- Forge Log migration v5
-- Run in Supabase SQL Editor alongside your existing tables.
-- Adds the weigh_ins JSONB column to entries for the new Weigh-In tab.
-- Safe to run — only adds a column, never removes or changes existing data.

alter table entries
  add column if not exists weigh_ins jsonb not null default '[]'::jsonb;
