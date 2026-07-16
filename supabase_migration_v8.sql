-- Forge Log migration v8
-- Run in Supabase SQL Editor alongside your existing tables.
-- Adds goal_weight_lbs and mini_cut_started_on to profiles.
-- Safe to run — only adds columns, doesn't touch existing data.

alter table profiles
  add column if not exists goal_weight_lbs numeric,
  add column if not exists mini_cut_started_on date;
