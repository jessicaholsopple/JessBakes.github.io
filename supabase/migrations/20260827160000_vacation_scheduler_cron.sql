-- ============================================================
-- pg_cron schedule that drives the vacation-scheduler Edge Function
-- (Phase 5): checks every 5 minutes whether the active vacation
-- cycle's reopen_at has passed and, if so, auto-resumes ordering and
-- (only when the admin opted in and the campaign is genuinely ready)
-- sends the reopening campaign.
--
-- Reuses the SAME Vault secret already created for the email system
-- (project_service_role_key -- see 20260818130000_email_cron_
-- schedules.sql) -- no new manual setup step needed.
--
-- Safe to apply before vacation-scheduler is deployed: each run just
-- fails inside the (not-yet-existing) Edge Function, logged and
-- harmless, touching no data -- and there is no active vacation cycle
-- in production yet regardless.
--
-- Idempotent: cron.schedule() upserts by job name.
-- ============================================================
begin;

select cron.schedule(
  'vacation-scheduler',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://fbfvqiuhwqfhhxufgmla.supabase.co/functions/v1/vacation-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'project_service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);

commit;
