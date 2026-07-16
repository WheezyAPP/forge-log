-- Forge Log migration v12
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds goal_started_on to profiles — generalizes the "start date" idea
-- that mini_cut_started_on already provided, so a regular "lose" or
-- "gain" goal can also track how many days in you are and compute an
-- accurate accumulated deficit/surplus from a real date, instead of
-- falling back to your first-ever logged day as a rough proxy.
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table profiles
  add column if not exists goal_started_on date;
