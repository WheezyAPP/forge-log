-- Forge Log migration v6
-- Run in Supabase SQL Editor alongside your existing tables.
-- Adds weak_point_groups to user_splits — stores which muscle group(s)
-- a user picked for the "Weak Point Day" in the PPL + Weak Point split.
-- Safe to run — only adds a column, doesn't touch existing rows.

alter table user_splits
  add column if not exists weak_point_groups jsonb not null default '[]'::jsonb;
