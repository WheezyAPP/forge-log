-- Forge Log migration v20
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds creatine_already_saturated to profiles — lets someone who's
-- already been taking creatine consistently before joining the app mark
-- themselves as already at steady-state, instead of the Creatine
-- Saturation card reading "just starting" on day one because it can only
-- see logged days since they joined.
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table profiles
  add column if not exists creatine_already_saturated boolean not null default false;
