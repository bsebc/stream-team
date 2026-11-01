-- ============================================================
-- Stream Team — hourly reminder schedule
-- Run this AFTER the notify function is deployed and tested.
--
-- Replace the two placeholders:
--   <PROJECT-REF>  Settings -> General -> Reference ID
--   <SECRET_KEY>   Settings -> API Keys -> Secret keys (starts sb_secret_)
--
-- Note: the new secret keys are NOT JWTs, so they must travel on the
-- "apikey" header. Authorization: Bearer only works with the older
-- service_role key.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'stream-team-reminders',
  '0 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT-REF>.supabase.co/functions/v1/notify',
    headers := '{"Content-Type":"application/json","apikey":"<SECRET_KEY>"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);


-- ---------- Verify ----------

-- Is it registered?
select jobid, schedule, jobname from cron.job;

-- Did it run? (check after the next hour turns over)
select status, return_message, start_time
from cron.job_run_details
order by start_time desc
limit 10;


-- ---------- Manage ----------

-- Remove it
-- select cron.unschedule('stream-team-reminders');

-- Change the frequency (example: every 30 minutes)
-- select cron.alter_job(
--   (select jobid from cron.job where jobname = 'stream-team-reminders'),
--   schedule := '*/30 * * * *'
-- );
