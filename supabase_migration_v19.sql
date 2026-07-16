-- Forge Log migration v19
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds show_body_fat_pct to profiles — an explicit show/hide preference
-- for body fat % (and fat mass, which is directly derived from it)
-- across the whole app. Nullable on purpose: null means "no explicit
-- choice made," in which case the app defaults to hidden for female
-- profiles and shown for male profiles, since this can be sensitive
-- information. Once a user explicitly sets it either way, that choice
-- sticks regardless of gender changes afterward.
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table profiles
  add column if not exists show_body_fat_pct boolean;
