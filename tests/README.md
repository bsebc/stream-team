# Local test stack

A copy of the whole app that runs on one machine, so changes can be tried before they
reach the live site or the live database:

- **Postgres 16**, loaded with a mirror of the live `stream` schema (same columns,
  policies and grants — `sql/00_live_baseline.sql`), sample data (`sql/01_seed.sql`, the
  real 2026-27 schedule with fake Telegram handles), then every file in
  `../supabase/migrations/` in order.
- **`server.mjs`**: a small PostgREST-compatible server that enforces row-level security
  by switching to the `anon` / `service_role` roles, runs the real
  `../supabase/functions/notify/index.ts` in-process, fakes Telegram (and rejects
  malformed HTML the way Telegram does), and serves the site.
- **`api_test.mjs`**: 91 checks of every member and admin action, races, PIN lockout,
  reminders and abuse limits.
- **`e2e_test.mjs`**: 60 checks driving the real page in Chromium through every flow,
  in English, Russian and on desktop.

## Run

```sh
npm install
# a throwaway Postgres on port 54329 (any local Postgres 16 works; set PGPORT)
initdb -D /tmp/pgdata -A trust -U postgres
pg_ctl -D /tmp/pgdata -o "-p 54329 -c listen_addresses=127.0.0.1" start
psql -h 127.0.0.1 -p 54329 -U postgres -c "create database streamtest"

./reset.sh streamtest new        # schema + data + all migrations
./start.sh 8788 streamtest       # site + API + function on http://127.0.0.1:8788
node api_test.mjs
./reset.sh streamtest new && node e2e_test.mjs
```

Open `http://127.0.0.1:8788` to click around; `GET /__test/telegram` shows what the bot
would have sent. Admin PIN in the sample data is `1234`.
