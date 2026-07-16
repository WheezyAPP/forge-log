-- Run this in Supabase SQL Editor if you already created your tables before
-- (i.e. you ran supabase_schema.sql once already). This just adds the two
-- new columns needed for the Daily Food Log and Measurements features.
-- Safe to run even if the columns already exist.

alter table entries add column if not exists meals jsonb not null default '[]'::jsonb;
alter table entries add column if not exists measurements jsonb not null default '{}'::jsonb;
