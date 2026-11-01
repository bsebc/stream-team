-- ============================================================
-- Stream Team — one-shot schema catch-up.
--
-- Brings the database to the current app version no matter which of the
-- earlier migrations were already run. Every statement is idempotent, so
-- running this is safe whether you have applied none, some, or all of
-- them. Nothing is dropped and no schedule data is touched.
--
-- Paste the whole thing into the SQL Editor and press Run.
-- ============================================================

-- ---- cancelled services ------------------------------------
-- Services get called off. Deleting the row would lose the record and
-- silently change people's history, so it is flagged and kept instead.
alter table stream.services
  add column if not exists cancelled bool not null default false;

comment on column stream.services.cancelled is
  'Admin called this service off. Row is kept for the record; ignored by reminders and stats.';

create index if not exists services_pending_idx
  on stream.services (date)
  where cancelled = false;

-- ---- replacement history -----------------------------------
-- Plain text, deliberately NOT a foreign key: if a member is later
-- deleted we still want the record that a hand-off happened.
alter table stream.services
  add column if not exists replaced_from text;

comment on column stream.services.replaced_from is
  'Member who originally held this service before someone covered it. Null = never handed off.';

-- ---- confirmation window + last-call warning ---------------
alter table stream.services
  add column if not exists warned bool not null default false;

alter table stream.settings
  add column if not exists notify_unconfirmed bool not null default true,
  add column if not exists warn_hours int not null default 2;

-- Anything already past must not fire a retrospective warning.
update stream.services
   set warned = true
 where (date + time) < now()
   and warned = false;

-- ---- time zone ---------------------------------------------
-- The Edge Function runs in UTC. Service times are wall-clock times in
-- the church's own zone, so the zone has to be stored to convert them.
alter table stream.settings
  add column if not exists timezone text not null default 'America/New_York';

comment on column stream.settings.timezone is
  'IANA zone the service times are written in, e.g. America/New_York. Set it from Admin -> Time zone.';

-- ---- the view the app reads --------------------------------
create or replace view stream.settings_public as
  select group_name, rem_hours, dm_duty, alert_swap,
         notify_reminder_group, notify_pickup, notify_confirm, notify_schedule,
         notify_unconfirmed, warn_hours, timezone
  from stream.settings;

grant select on stream.settings_public to anon, authenticated;

-- ---- grants the Edge Function needs ------------------------
-- service_role bypasses row-level security but still needs ordinary
-- schema and table grants, or every admin action fails with
-- "permission denied for schema stream".
grant usage on schema stream to service_role, postgres;
grant all on all tables    in schema stream to service_role, postgres;
grant all on all sequences in schema stream to service_role, postgres;

alter default privileges in schema stream
  grant all on tables to service_role, postgres;
alter default privileges in schema stream
  grant all on sequences to service_role, postgres;

-- ============================================================
-- Verify. Every "has_" column must read 1, and settings must
-- show one row with your zone and reminder hours.
-- ============================================================
select
  count(*) filter (where column_name = 'cancelled')     as has_cancelled,
  count(*) filter (where column_name = 'replaced_from') as has_replaced_from,
  count(*) filter (where column_name = 'warned')        as has_warned
from information_schema.columns
where table_schema = 'stream' and table_name = 'services';

select timezone, rem_hours, warn_hours, notify_unconfirmed
from stream.settings;
