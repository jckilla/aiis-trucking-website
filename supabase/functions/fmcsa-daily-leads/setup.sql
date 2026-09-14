-- One-time setup for the fmcsa-daily-leads Edge Function (applied to prod 2026-09-14 as migration
-- fmcsa_daily_leads_setup). Kept here for reference; contains no secrets - the cron secret is
-- generated inside Postgres and read back only by the service-role RPC below.

-- 1. Private schema + per-job secrets (never exposed through the API)
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.job_secrets (
  job        text primary key,
  secret     text not null,
  created_at timestamptz not null default now()
);
revoke all on private.job_secrets from public, anon, authenticated;

insert into private.job_secrets (job, secret)
values ('fmcsa-daily-leads', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (job) do nothing;

-- 2. Service-role-only check used by the function
create or replace function public.job_secret_ok(p_job text, p_secret text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.job_secrets s
    where s.job = p_job and p_secret is not null and length(p_secret) >= 32 and s.secret = p_secret
  );
$$;
revoke all on function public.job_secret_ok(text, text) from public, anon, authenticated;
grant execute on function public.job_secret_ok(text, text) to service_role;

-- 3. Run log (service role writes; masters can read it from the SQL editor)
create table if not exists public.fmcsa_daily_runs (
  id      bigserial primary key,
  run_at  timestamptz not null default now(),
  params  jsonb,
  summary jsonb,
  error   text
);
revoke all on public.fmcsa_daily_runs from public, anon, authenticated;
alter table public.fmcsa_daily_runs enable row level security;

-- 4. Schedule: 16:00 and 17:00 UTC; the function only does work when it is 9 AM in Los Angeles,
--    so the job lands at 9 AM Pacific in both PDT and PST. The secret is read at run time.
select cron.unschedule('fmcsa-daily-leads') where exists (select 1 from cron.job where jobname = 'fmcsa-daily-leads');
select cron.schedule(
  'fmcsa-daily-leads',
  '0 16,17 * * *',
  $cron$
  select net.http_post(
    url     := 'https://cqijyhudfiteivejcgox.supabase.co/functions/v1/fmcsa-daily-leads',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select secret from private.job_secrets where job = 'fmcsa-daily-leads')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $cron$
);

-- 5. The living "cancelling soon" list gets a name without a date in it
update public.crm_leads
set call_list = 'BMC-35 CA Cancelling Soon'
where org_id = '00000000-0000-0000-0000-0000000000a1' and call_list = 'BMC-35 CA Cancellations - 2026-09-11';
