-- ============================================================================
-- pg_cron + pg_net heartbeat for the hourly summarize fan-out.
--
-- DO NOT run this until the web app is deployed (you need the live URL) and you
-- have chosen a CRON_SECRET (the same value set in the Vercel env).
--
-- Replace before running:
--   <APP_URL>      e.g. https://menitoring.vercel.app
--   <CRON_SECRET>  the exact string set as CRON_SECRET in Vercel
--
-- Apply via the Supabase SQL editor (or `apply_migration`) once those exist.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Run at minute 5 of every hour: lets the just-ended hour's late events settle,
-- then POSTs the protected summarize endpoint, which does the per-user fan-out.
select cron.schedule(
  'summarize-hourly',
  '5 * * * *',
  $$
  select net.http_post(
    url     := '<APP_URL>/api/cron/summarize',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Daily retention: drop summarized raw events older than 7 days to stay under
-- free-tier row caps. Runs at 03:10 UTC.
select cron.schedule(
  'events-cleanup-daily',
  '10 3 * * *',
  $$
  delete from public.events
  where summarized_at is not null
    and started_at < now() - interval '7 days';
  $$
);

-- To inspect or remove later:
--   select * from cron.job;
--   select cron.unschedule('summarize-hourly');
--   select cron.unschedule('events-cleanup-daily');
