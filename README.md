# Stream Team — livestream duty schedule

Live at **https://stream.bsebc.com**

## What is in this folder

| File | What it is |
| --- | --- |
| `index.html` | The whole app. Open it in a browser and it runs. |
| `support.js` | Runtime the app needs. Must sit next to `index.html`. |
| `manifest.webmanifest`, `icon-*.png` | Makes "Add to Home Screen" install it like a real app. |
| `CNAME` | Tells GitHub Pages the site answers at stream.bsebc.com. |
| `.nojekyll` | Stops GitHub from rewriting filenames. Keep it, even though it is empty. |
| `schedule.sql` | Your 2026 schedule, ready to paste into Supabase. Not used by the site. |

## Putting it online

1. Create a **public** repo on GitHub (any name — `stream-team` is fine).
2. Upload everything in this folder to the root of the repo. Not the folder itself — its contents.
3. **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main`, Folder: `/ (root)`. Save.
4. Wait a minute, then open `https://<your-username>.github.io/<repo>/` to check it works.
5. At your DNS host for bsebc.com add: `CNAME` · name `stream` · value `<your-username>.github.io`
6. **Settings → Pages → Custom domain** → `stream.bsebc.com`. Once the certificate check goes green, tick **Enforce HTTPS**.

Changing anything later means editing `index.html` and pushing — the site updates within a minute.

## Note on the current version

This build stores the schedule **in each browser**, so every phone has its own copy and the
Telegram messages are previewed rather than sent (tap the paper-plane icon top right to see them).
It is fully usable for one person and good for showing the team what is coming.

For the shared, notifying version you need the Supabase database and Telegram bot from the launch
guide — steps 2 to 5. `schedule.sql` is the schedule ready for that database.

## Admin

PIN **1234**. Change it under Admin → Change PIN. In this browser-storage build the PIN lives on the
device; once the database is connected it is checked on the server instead.
