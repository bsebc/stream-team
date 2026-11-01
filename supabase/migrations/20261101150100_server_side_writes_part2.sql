-- ============================================================
-- 2026-11-01 · part 2 of 2 · lock the tables to read-only
--
-- Run ONLY after the app version that sends every change through the
-- notify function is live (index.html from 2026-11-01 or later). An older
-- page still open on a phone will fail to save until it is reloaded.
--
-- Before this, anyone holding the public (publishable) key could rewrite
-- any service row directly — reassign turns, cancel services, change dates —
-- and insert or edit requests, bypassing every rule in the app.
-- ============================================================

-- No direct writes from the browser, to any table.
drop policy if exists "claim service"  on stream.services;
drop policy if exists "open request"   on stream.requests;
drop policy if exists "answer request" on stream.requests;

revoke insert, update, delete, truncate, references, trigger
  on all tables in schema stream from anon, authenticated;

-- settings holds the admin PIN: no browser access at all (the app reads
-- the safe columns through the settings_public view).
revoke all on stream.settings    from anon, authenticated;
revoke all on stream.rate_limits from anon, authenticated;

-- members: everything except the Telegram chat id.
revoke select on stream.members from anon, authenticated;
grant  select (id, name, name_ru, telegram, share_pct, active, linked)
  on stream.members to anon, authenticated;

-- Nothing in this schema is callable as an RPC from the browser.
revoke execute on all functions in schema stream from public, anon, authenticated;

-- And keep it that way for tables/functions created later.
alter default privileges in schema stream
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
alter default privileges in schema stream
  revoke execute on functions from public;

-- ---- verify ------------------------------------------------
-- Expect: no INSERT/UPDATE/DELETE rows for anon, and only SELECT policies.
select table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'stream' and grantee = 'anon'
 order by 1, 2;

select tablename, policyname, cmd from pg_policies where schemaname = 'stream' order by 1;
