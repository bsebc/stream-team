-- ============================================================
-- Stream Team — full database setup, isolated in its own schema
-- Safe to run inside an existing Supabase project.
-- Paste the whole file into the SQL Editor and hit Run once.
-- ============================================================

-- ---------- 1. Schema ----------
-- Everything lives under "stream." so it cannot collide with the
-- tables your other app already has in "public".

create schema if not exists stream;

-- ---------- 2. Tables ----------

create table stream.members (
  id         text primary key,          -- 'vanya'
  name       text not null,
  name_ru    text,
  telegram   text,                      -- '@vanya'
  chat_id    bigint,                    -- filled when they DM the bot
  share_pct  int  not null default 10,  -- target share of services
  active     bool not null default true
);

create table stream.services (
  id         text primary key,          -- '2026-08-30M'
  date       date not null,
  part       text not null check (part in ('M','E','S')),
  time       time not null,
  member_id  text references stream.members(id) on delete set null,
  special    text not null default '',  -- 'Christmas Eve' for one-offs
  open       bool not null default false,-- someone asked for cover
  confirmed  bool not null default false,
  notified   bool not null default false -- reminder already sent
);

create index on stream.services (date);
create index on stream.services (member_id);

create table stream.requests (
  id         uuid primary key default gen_random_uuid(),
  service_id text references stream.services(id) on delete cascade,
  from_id    text references stream.members(id),
  to_id      text references stream.members(id),  -- null = open to all
  status     text not null default 'pending',
  created_at timestamptz not null default now()
);

create table stream.settings (
  id          int primary key default 1,
  admin_pin   text not null default '1234',
  group_name  text not null default 'Stream Team',
  rem_hours   int  not null default 24,
  dm_duty     bool not null default true,
  alert_swap  bool not null default true
);

insert into stream.settings (id) values (1);

-- ---------- 3. Security ----------
-- Anyone can read the schedule. Members can claim a turn, confirm,
-- and open a request. Nobody can touch members or settings from the
-- browser — admin actions go through the Edge Function.

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

-- settings: no browser access at all (service key bypasses RLS)

-- ---------- 4. API access ----------
-- Lets the app reach the schema through the REST API.

grant usage on schema stream to anon, authenticated;
grant select on all tables in schema stream to anon, authenticated;
grant update on stream.services to anon, authenticated;
grant insert, update on stream.requests to anon, authenticated;

-- ---------- 5. Your team ----------
-- Replace the @handles with each person's real Telegram username.

insert into stream.members (id, name, name_ru, telegram, share_pct, active) values
  ('roman',  'Roman',  'Роман',  '@roman',  19, true),
  ('vanya',  'Vanya',  'Ваня',   '@vanya',  25, true),
  ('vlad',   'Vlad',   'Влад',   '@vlad',   25, true),
  ('tima',   'Tima',   'Тима',   '@tima',   12, true),
  ('viktor', 'Viktor', 'Виктор', '@viktor', 10, true),
  ('nate',   'Nate',   'Нейт',   '@nate',   10, true);

-- ---------- 6. The 2026 schedule ----------
-- Straight from Video Schedule.xlsx. Morning 10:00, Evening 18:00.

insert into stream.services (id, date, part, time, member_id) values
  ('2026-01-04M', '2026-01-04', 'M', '10:00', 'roman'),
  ('2026-01-04E', '2026-01-04', 'E', '18:00', 'vanya'),
  ('2026-01-11M', '2026-01-11', 'M', '10:00', 'vanya'),
  ('2026-01-11E', '2026-01-11', 'E', '18:00', 'vlad'),
  ('2026-01-18M', '2026-01-18', 'M', '10:00', 'vlad'),
  ('2026-01-18E', '2026-01-18', 'E', '18:00', 'tima'),
  ('2026-01-25M', '2026-01-25', 'M', '10:00', 'roman'),
  ('2026-01-25E', '2026-01-25', 'E', '18:00', 'nate'),
  ('2026-02-01M', '2026-02-01', 'M', '10:00', 'vanya'),
  ('2026-02-01E', '2026-02-01', 'E', '18:00', 'roman'),
  ('2026-02-08M', '2026-02-08', 'M', '10:00', 'vlad'),
  ('2026-02-08E', '2026-02-08', 'E', '18:00', 'vanya'),
  ('2026-02-15M', '2026-02-15', 'M', '10:00', 'tima'),
  ('2026-02-15E', '2026-02-15', 'E', '18:00', 'vlad'),
  ('2026-02-22M', '2026-02-22', 'M', '10:00', 'nate'),
  ('2026-02-22E', '2026-02-22', 'E', '18:00', 'viktor'),
  ('2026-03-01M', '2026-03-01', 'M', '10:00', 'roman'),
  ('2026-03-01E', '2026-03-01', 'E', '18:00', 'vanya'),
  ('2026-03-08M', '2026-03-08', 'M', '10:00', 'vanya'),
  ('2026-03-08E', '2026-03-08', 'E', '18:00', 'vlad'),
  ('2026-03-15M', '2026-03-15', 'M', '10:00', 'vlad'),
  ('2026-03-15E', '2026-03-15', 'E', '18:00', 'tima'),
  ('2026-03-22M', '2026-03-22', 'M', '10:00', 'viktor'),
  ('2026-03-22E', '2026-03-22', 'E', '18:00', 'roman'),
  ('2026-03-29M', '2026-03-29', 'M', '10:00', 'vanya'),
  ('2026-03-29E', '2026-03-29', 'E', '18:00', 'roman'),
  ('2026-04-05M', '2026-04-05', 'M', '10:00', 'vlad'),
  ('2026-04-05E', '2026-04-05', 'E', '18:00', 'vanya'),
  ('2026-04-12M', '2026-04-12', 'M', '10:00', 'tima'),
  ('2026-04-12E', '2026-04-12', 'E', '18:00', 'vlad'),
  ('2026-04-19M', '2026-04-19', 'M', '10:00', 'nate'),
  ('2026-04-19E', '2026-04-19', 'E', '18:00', 'viktor'),
  ('2026-04-26M', '2026-04-26', 'M', '10:00', 'roman'),
  ('2026-04-26E', '2026-04-26', 'E', '18:00', 'vanya'),
  ('2026-05-03M', '2026-05-03', 'M', '10:00', 'vanya'),
  ('2026-05-03E', '2026-05-03', 'E', '18:00', 'vlad'),
  ('2026-05-10M', '2026-05-10', 'M', '10:00', 'vlad'),
  ('2026-05-10E', '2026-05-10', 'E', '18:00', 'tima'),
  ('2026-05-17M', '2026-05-17', 'M', '10:00', 'roman'),
  ('2026-05-17E', '2026-05-17', 'E', '18:00', 'nate'),
  ('2026-05-24M', '2026-05-24', 'M', '10:00', 'vanya'),
  ('2026-05-24E', '2026-05-24', 'E', '18:00', 'roman'),
  ('2026-05-31M', '2026-05-31', 'M', '10:00', 'vlad'),
  ('2026-05-31E', '2026-05-31', 'E', '18:00', 'vanya'),
  ('2026-06-07M', '2026-06-07', 'M', '10:00', 'tima'),
  ('2026-06-07E', '2026-06-07', 'E', '18:00', 'vlad'),
  ('2026-06-14M', '2026-06-14', 'M', '10:00', 'nate'),
  ('2026-06-14E', '2026-06-14', 'E', '18:00', 'viktor'),
  ('2026-06-21M', '2026-06-21', 'M', '10:00', 'roman'),
  ('2026-06-21E', '2026-06-21', 'E', '18:00', 'vanya'),
  ('2026-06-28M', '2026-06-28', 'M', '10:00', 'vanya'),
  ('2026-06-28E', '2026-06-28', 'E', '18:00', 'vlad'),
  ('2026-07-05M', '2026-07-05', 'M', '10:00', 'vlad'),
  ('2026-07-05E', '2026-07-05', 'E', '18:00', 'tima'),
  ('2026-07-12M', '2026-07-12', 'M', '10:00', 'viktor'),
  ('2026-07-12E', '2026-07-12', 'E', '18:00', 'roman'),
  ('2026-07-19M', '2026-07-19', 'M', '10:00', 'vanya'),
  ('2026-07-19E', '2026-07-19', 'E', '18:00', 'roman'),
  ('2026-07-26M', '2026-07-26', 'M', '10:00', 'vlad'),
  ('2026-07-26E', '2026-07-26', 'E', '18:00', 'vanya'),
  ('2026-08-02M', '2026-08-02', 'M', '10:00', 'tima'),
  ('2026-08-02E', '2026-08-02', 'E', '18:00', 'vlad'),
  ('2026-08-09M', '2026-08-09', 'M', '10:00', 'nate'),
  ('2026-08-09E', '2026-08-09', 'E', '18:00', 'viktor'),
  ('2026-08-16M', '2026-08-16', 'M', '10:00', 'roman'),
  ('2026-08-16E', '2026-08-16', 'E', '18:00', 'vanya'),
  ('2026-08-23M', '2026-08-23', 'M', '10:00', 'vanya'),
  ('2026-08-23E', '2026-08-23', 'E', '18:00', 'vlad'),
  ('2026-08-30M', '2026-08-30', 'M', '10:00', 'vlad'),
  ('2026-08-30E', '2026-08-30', 'E', '18:00', 'tima'),
  ('2026-09-06M', '2026-09-06', 'M', '10:00', 'roman'),
  ('2026-09-06E', '2026-09-06', 'E', '18:00', 'nate'),
  ('2026-09-13M', '2026-09-13', 'M', '10:00', 'vanya'),
  ('2026-09-13E', '2026-09-13', 'E', '18:00', 'roman'),
  ('2026-09-20M', '2026-09-20', 'M', '10:00', 'vlad'),
  ('2026-09-20E', '2026-09-20', 'E', '18:00', 'vanya'),
  ('2026-09-27M', '2026-09-27', 'M', '10:00', 'tima'),
  ('2026-09-27E', '2026-09-27', 'E', '18:00', 'vlad'),
  ('2026-10-04M', '2026-10-04', 'M', '10:00', 'nate'),
  ('2026-10-04E', '2026-10-04', 'E', '18:00', 'viktor'),
  ('2026-10-11M', '2026-10-11', 'M', '10:00', 'roman'),
  ('2026-10-11E', '2026-10-11', 'E', '18:00', 'vanya'),
  ('2026-10-18M', '2026-10-18', 'M', '10:00', 'vanya'),
  ('2026-10-18E', '2026-10-18', 'E', '18:00', 'vlad'),
  ('2026-10-25M', '2026-10-25', 'M', '10:00', 'vlad'),
  ('2026-10-25E', '2026-10-25', 'E', '18:00', 'tima'),
  ('2026-11-01M', '2026-11-01', 'M', '10:00', 'viktor'),
  ('2026-11-01E', '2026-11-01', 'E', '18:00', 'roman'),
  ('2026-11-08M', '2026-11-08', 'M', '10:00', 'vanya'),
  ('2026-11-08E', '2026-11-08', 'E', '18:00', 'roman'),
  ('2026-11-15M', '2026-11-15', 'M', '10:00', 'vlad'),
  ('2026-11-15E', '2026-11-15', 'E', '18:00', 'vanya'),
  ('2026-11-22M', '2026-11-22', 'M', '10:00', 'tima'),
  ('2026-11-22E', '2026-11-22', 'E', '18:00', 'vlad'),
  ('2026-11-29M', '2026-11-29', 'M', '10:00', 'nate'),
  ('2026-11-29E', '2026-11-29', 'E', '18:00', 'viktor'),
  ('2026-12-06M', '2026-12-06', 'M', '10:00', 'roman'),
  ('2026-12-06E', '2026-12-06', 'E', '18:00', 'vanya'),
  ('2026-12-13M', '2026-12-13', 'M', '10:00', 'vanya'),
  ('2026-12-13E', '2026-12-13', 'E', '18:00', 'vlad'),
  ('2026-12-20M', '2026-12-20', 'M', '10:00', 'vlad'),
  ('2026-12-20E', '2026-12-20', 'E', '18:00', 'roman'),
  ('2026-12-27M', '2026-12-27', 'M', '10:00', 'viktor'),
  ('2026-12-27E', '2026-12-27', 'E', '18:00', 'nate');

-- ---------- 7. Check it worked ----------
-- Expect 104 services and: Vanya 26, Vlad 26, Roman 20,
-- Tima 12, Viktor 10, Nate 10.

select m.name, count(*) as services
from stream.services s
join stream.members m on m.id = s.member_id
group by m.name
order by services desc;
