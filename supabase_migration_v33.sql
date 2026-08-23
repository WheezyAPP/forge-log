-- Forge Log migration v33
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds a per-profile custom loss rate (percent of bodyweight/week,
-- optionally tapering to a gentler rate once a weight threshold is
-- crossed) as an alternative to mini_cut's flat 25%-below-TDEE rule.
-- When set, computeStats (App.jsx) uses this instead of the flat
-- percentage — recalculated fresh every time off whatever the CURRENT
-- adaptive TDEE and weight are, so "Suggested calories" stays correct
-- automatically as both change, with no need to hand-update a stored
-- number every time TDEE shifts.
--
-- Defaults to null for every existing profile, so mini_cut's normal
-- flat-25% behavior is completely unaffected for anyone who doesn't
-- have this set — purely additive/opt-in.
--
-- Safe to run — only adds columns, doesn't touch existing data.

alter table profiles add column if not exists custom_loss_rate_pct numeric;
alter table profiles add column if not exists custom_loss_rate_taper_weight numeric;
alter table profiles add column if not exists custom_loss_rate_tapered_pct numeric;
