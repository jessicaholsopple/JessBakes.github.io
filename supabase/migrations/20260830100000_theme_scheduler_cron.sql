-- ============================================================
-- pg_cron schedule that drives the theme-scheduler Edge Function:
-- checks every 5 minutes whether the resolved theme should change
-- (a schedule window opened/closed, or a manual override expired)
-- and updates theme_state accordingly. Exact copy of
-- 20260827160000_vacation_scheduler_cron.sql's pattern, reusing the
-- SAME Vault secret already created for the email/vacation systems --
-- no new manual setup step needed.
--
-- Safe to apply before theme-scheduler is deployed: each run just
-- fails inside the (not-yet-existing) Edge Function, logged and
-- harmless, touching no data.
--
-- Idempotent: cron.schedule() upserts by job name.
-- ============================================================
begin;

select cron.schedule(
  'theme-scheduler',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://fbfvqiuhwqfhhxufgmla.supabase.co/functions/v1/theme-scheduler',
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
