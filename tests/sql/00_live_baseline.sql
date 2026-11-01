-- Local mirror of the LIVE Stream Team database as of 2026-11-01, before any
-- of today's changes: same tables, columns, policies and (over-broad) grants.
-- Used only by the local test harness.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

drop schema if exists stream cascade;
create schema stream;

create table stream.members (
  id         text primary key,
  name       text not null,
  name_ru    text,
  telegram   text,
  chat_id    bigint,
  share_pct  int  not null default 10,
  active     bool not null default true
);

create table stream.services (
  id            text primary key,
  date          date not null,
  part          text not null check (part in ('M','E','S')),
  time          time not null,
  member_id     text references stream.members(id) on delete set null,
  special       text not null default '',
  open          bool not null default false,
  confirmed     bool not null default false,
  notified      bool not null default false,
  warned        bool not null default false,
  replaced_from text,
  cancelled     bool not null default false
);
create index on stream.services (date);
create index on stream.services (member_id);
create index services_pending_idx on stream.services (date) where cancelled = false;

create table stream.requests (
  id         uuid primary key default gen_random_uuid(),
  service_id text references stream.services(id) on delete cascade,
  from_id    text references stream.members(id),
  to_id      text references stream.members(id),
  status     text not null default 'pending',
  created_at timestamptz not null default now()
);

create table stream.settings (
  id                    int primary key default 1,
  admin_pin             text not null default '1234',
  group_name            text not null default 'Stream Team',
  rem_hours             int  not null default 24,
  dm_duty               bool not null default true,
  alert_swap            bool not null default true,
  notify_reminder_group bool not null default true,
  notify_pickup         bool not null default true,
  notify_confirm        bool not null default false,
  notify_schedule       bool not null default true,
  notify_unconfirmed    bool not null default true,
  warn_hours            int  not null default 2,
  timezone              text not null default 'America/New_York'
);

alter table stream.members  enable row level security;
alter table stream.services enable row level security;
alter table stream.requests enable row level security;
alter table stream.settings enable row level security;

create policy "read members"  on stream.members  for select using (true);
create policy "read services" on stream.services for select using (true);
create policy "read requests" on stream.requests for select using (true);
create policy "claim service"  on stream.services for update using (true) with check (true);
create policy "open request"   on stream.requests for insert with check (true);
create policy "answer request" on stream.requests for update using (true) with check (true);

create view stream.settings_public as
  select group_name, rem_hours, dm_duty, alert_swap,
         notify_reminder_group, notify_pickup, notify_confirm, notify_schedule,
         notify_unconfirmed, warn_hours, timezone
  from stream.settings;

-- Live grants: anon/authenticated hold every table privilege; RLS is the
-- only thing standing between them and the data.
grant usage on schema stream to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema stream to anon, authenticated;
grant all on all tables in schema stream to service_role;
grant all on all sequences in schema stream to service_role;
