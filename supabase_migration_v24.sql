-- Forge Log migration v24
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds dedicated_progressive_overload to profiles — per-user opt-in flag
-- for RPE/RIR-driven autoregulation in the progression suggestion engine
-- (getProgressionSuggestion in splits.js). When true, Daily Log shows an
-- RPE input per set, and suggestions weigh how hard the last session
-- actually felt, not just whether the rep ceiling was hit. When false
-- (the default), the suggestion engine still uses the upgraded
-- percentage-based/practically-rounded increment math — that part is
-- always on for everyone, this flag only gates the RPE layer on top.
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table profiles
  add column if not exists dedicated_progressive_overload boolean not null default false;
