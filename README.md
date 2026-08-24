# Stream Team — livestream duty schedule

Live at **https://stream.bsebc.com**

## Files that go in the GitHub repo

| File | What it is |
| --- | --- |
| `index.html` | The whole app |
| `support.js` | Runtime the app needs. Must sit beside index.html |
| `config.js` | **The only file you edit.** Your Supabase URL + publishable key |
| `manifest.webmanifest`, `icon-*.png` | Makes "Add to Home Screen" install it like an app |
| `CNAME` | Points the site at stream.bsebc.com |
| `.nojekyll` | Stops GitHub rewriting filenames. Keep it, even though it is empty |

The `supabase/` folder and `schedule.sql` are setup material — they do NOT
need to be in the repo, though it is harmless (and good record-keeping) to
keep them there.

## Setting up config.js

Open `config.js` and paste two values from
**Supabase dashboard -> Project Settings -> API Keys**:

```js
window.STREAM_CONFIG = {
  url: "https://abcdefgh.supabase.co",
  key: "sb_publishable_..."
};
```

Use the **publishable** key, not the secret key. The publishable key is meant to
be public and is safe in a public repo — your row-level security policies are
what protect the data. The secret key (`sb_secret_...`) must never appear here.

Until you fill this in, the app shows an orange "Not connected yet" banner.

## One setting to change before it works

The app calls the Edge Function directly, so that function must accept calls
without a Supabase user login:

**Edge Functions -> notify -> Settings -> turn OFF "Verify JWT" / "Enforce JWT verification"**

This is safe. Admin actions are guarded by the PIN, which the function checks on
the server. Reminder sending and Telegram messages carry no privileged data.

## Order of operations

1. `schedule.sql` — creates tables, loads members and the 2026 schedule
2. **Project Settings -> API -> Exposed schemas** -> add `stream`
3. Deploy the `notify` function, add `TELEGRAM_TOKEN` and `TELEGRAM_GROUP` secrets, turn off Verify JWT
4. `supabase/cron.sql` — schedules hourly reminders
5. `supabase/step5.sql` — adds the settings view, grants and live updates
6. Fill in `config.js`, push everything to GitHub, turn on Pages

## How it behaves once live

- Every phone reads the same schedule. Changes appear on other phones within a second (or 20 seconds if realtime is off).
- **Who you are** is stored on your own device only. Tap the name pill in the top right, once.
- **Request replacement** posts to the Telegram group; the first person to tap "I'll cover it" is put on the schedule and the group is told.
- **Ask** sends a direct message to one person, who gets Accept / Decline in the app.
- **Admin** actions need the PIN. It is verified server-side, so it cannot be read out of the page.
- Reminders fire from Supabase on a schedule, so they work whether or not anyone has the app open.

## Admin PIN

Starts as **1234**. Change it immediately: Admin -> Change PIN.

## If something looks wrong

| Symptom | Cause |
| --- | --- |
| Orange "Not connected yet" | `config.js` still has placeholder values |
| Red "Cannot reach the database" | Wrong URL/key, or `stream` not in Exposed schemas |
| Admin PIN always rejected | Verify JWT is still on for the `notify` function |
| Schedule loads but no Telegram messages | Missing `TELEGRAM_TOKEN` / `TELEGRAM_GROUP` secret |
| Reminders never arrive | Check `select * from cron.job_run_details order by start_time desc` |
