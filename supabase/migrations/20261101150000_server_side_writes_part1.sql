-- ============================================================
-- 2026-11-01 · part 1 of 2 · additive only
--
-- Safe to run while any version of the app is live: it only adds things.
-- Every statement is idempotent.
-- ============================================================

-- ---- members.linked ----------------------------------------
-- The app only needs to know WHETHER a member can receive DMs, not their
-- Telegram chat id. Part 2 hides chat_id from the browser; this column
-- carries the yes/no in its place.
alter table stream.members
  add column if not exists linked bool generated always as (chat_id is not null) stored;

-- ---- one pending request per service -----------------------
-- Two pending requests on one turn (a double tap, two phones at once) is
-- never valid. Close any duplicates, oldest wins, then let the database
-- refuse new ones.
update stream.requests r
   set status = 'cancelled'
 where r.status = 'pending'
   and exists (
     select 1 from stream.requests o
      where o.service_id = r.service_id
        and o.status = 'pending'
        and (o.created_at, o.id) < (r.created_at, r.id));

create unique index if not exists requests_one_pending
  on stream.requests (service_id)
  where status = 'pending';

-- ---- rate limits -------------------------------------------
-- Used by the notify function to slow down PIN guessing and floods of
-- actions from one address. Only the function (service_role) touches it.
create table if not exists stream.rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         int not null default 0
);
alter table stream.rate_limits enable row level security;
revoke all on stream.rate_limits from anon, authenticated;
grant all on stream.rate_limits to service_role;

-- Adds p_add hits to the key's current window (a fresh window once the old
-- one is p_window_secs old) and returns the new count. p_add = 0 just reads.
-- Rows idle for a day are swept on the way, so the table stays tiny.
create or replace function stream.rate_hit(p_key text, p_window_secs int, p_add int default 1)
returns int
language plpgsql
set search_path = stream, pg_temp
as $$
declare n int;
begin
  delete from stream.rate_limits where window_start < now() - interval '1 day';
  insert into stream.rate_limits as r (key, window_start, hits)
  values (p_key, now(), p_add)
  on conflict (key) do update
     set hits = case when r.window_start < now() - make_interval(secs => p_window_secs)
                     then p_add else r.hits + p_add end,
         window_start = case when r.window_start < now() - make_interval(secs => p_window_secs)
                     then now() else r.window_start end
  returning hits into n;
  return n;
end
$$;

revoke all on function stream.rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function stream.rate_hit(text, int, int) to service_role;
