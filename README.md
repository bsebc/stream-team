# Stream Team — livestream duty schedule

Live at **https://stream.bsebc.com**. Schedules who runs the church livestream at each
service, sends Telegram reminders, and handles hand-offs. English and Russian.

## How it fits together

| Piece | Where | What it does |
| --- | --- | --- |
| `index.html` | GitHub Pages (this repo, `main`) | The whole app. Pushing to `main` publishes it. |
| `supabase/functions/notify/index.ts` | Supabase Edge Function `notify` | **The only thing that writes to the database.** Validates every action, sends Telegram messages, runs the reminders. |
| `supabase/migrations/*.sql` | Supabase SQL | Schema changes, in order. Each file is safe to re-run. |
| `supabase/sql/cron.sql` | Supabase SQL | The hourly job that calls `notify` (already set up). |
| `supabase/sql/schedule.sql` | — | Original setup and 2026 data. History only — **do not re-run**. |

The browser can **read** the schedule (members, services, open requests, safe settings) and
nothing else. Every change — confirm, request replacement, cover, ask, accept, decline,
withdraw, and every admin action — is a `POST` to `notify`, which checks the change is
allowed (your turn, still open, not cancelled, inside the confirm window, right PIN …)
before making it. Two people tapping at once can't both win: the second gets a clear
"someone else just took it".

## Files in the repo root

| File | What it is |
| --- | --- |
| `index.html` | The app: a Design Component file (template + one `Component` class) |
| `support.js` | Runtime for `index.html`. Generated — don't edit |
| `config.js` | Supabase URL + **publishable** key (public by design; never put the secret key here) |
| `vendor/supabase-js-2.118.0.js` | Pinned copy of supabase-js, served from this site instead of a CDN |
| `fonts/` | Onest (text) and Unbounded (numbers), both with Cyrillic. OFL licences included |
| `manifest.webmanifest`, `icon*.png`, `icon.svg`, `favicon-*` | Home-screen app icons |
| `CNAME`, `.nojekyll` | Custom domain; stop GitHub rewriting paths. Keep both |

## Data model (schema `stream`)

- **members** — `id`, `name`, `name_ru`, `telegram`, `share_pct`, `active`, `chat_id`
  (hidden from the browser), `linked` (= has a chat id, so DMs work).
- **services** — one row per service, id = date + part (`2026-11-08E`; specials `S2026-12-241900`).
  `member_id`, `open` (replacement requested), `confirmed`, `notified`, `warned`,
  `replaced_from` (hand-off history), `cancelled` (kept for the record).
- **requests** — open calls for cover (`to_id` null) and direct asks. At most one
  `pending` per service (enforced by a unique index).
- **settings** — single row: admin PIN, reminder/last-call hours, time zone,
  notification switches. Browser reads the safe columns via the `settings_public` view.
- **rate_limits** — used by `notify` to slow PIN guessing and floods.

## Admin PIN

Checked in `notify` only. After 5 wrong tries from one network, sign-in pauses for 15
minutes (30 wrong tries in an hour across everyone pauses it for an hour). New PINs must be
at least 6 digits — change a 4-digit PIN from Admin → Change PIN.

## Deploying changes

1. **Database:** add a new file in `supabase/migrations/` (idempotent: `if not exists`,
   `create or replace`) and run it in the Supabase SQL editor (or via the Supabase connector).
2. **Function:** Supabase → Edge Functions → `notify` → replace the code with
   `supabase/functions/notify/index.ts` → Deploy. Keep the name `notify`.
3. **App:** push to `main`. GitHub Pages publishes within a minute or two; browsers may
   keep the old page for up to 10 minutes.

If a function change reads a new column, run the SQL first.

## Time zones and reminders

Service times are wall-clock times in the zone set in Admin (America/New_York). Both the
app and the bot convert with that zone, so daylight saving is handled. Reminders go out
exactly `rem_hours` before the service — so across a clock change the 24-hour reminder for
a Sunday 6 PM service arrives at 7 PM (autumn) or 5 PM (spring) on Saturday. That is
expected.

## Testing changes locally

The app was rebuilt and tested against a local copy of the whole stack (Postgres with
the same schema and policies, a PostgREST-compatible shim, the real `notify` code with a
fake Telegram) before going live: 91 API checks (every action, races, PIN lockout,
reminders) and 60 browser checks (every screen and flow, EN/RU, desktop). Ask Claude to
"run the Stream Team test harness" to repeat them.

## Changelog

### 2026-11-01 — redesign and hardening
- New design: native-feeling layout, bottom sheets, tally-light status lamps, dark mode,
  Russian times in 24-hour format, skeleton loading, clearer errors and toasts.
- All writes moved server-side; the database is read-only for the browser.
- PIN brute-force protection, Telegram HTML escaping, reminders can't double-post,
  inactive members get no reminders, deleting a member no longer fails, auto-fill clears
  stale requests, calendar export uses UTC times.
