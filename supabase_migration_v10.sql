-- Forge Log migration v10
-- Run in Supabase SQL Editor alongside your existing tables.
-- Adds an UPDATE policy on the users table. The original schema only
-- allowed select + insert on users, which under Row Level Security
-- silently blocks renaming a user and saving profile avatars.
-- Safe to run — drops/recreates only this one policy.

drop policy if exists "public update users" on users;
create policy "public update users" on users
  for update using (true) with check (true);
