-- Forge Log migration v7
-- Run in Supabase SQL Editor alongside your existing tables.
-- Adds avatar_data to users — stores a small compressed profile photo
-- as a base64 data URL (resized to ~160x160 client-side before saving,
-- so this stays small — no Supabase Storage bucket needed).
-- Safe to run — only adds a column, doesn't touch existing rows.

alter table users
  add column if not exists avatar_data text;
