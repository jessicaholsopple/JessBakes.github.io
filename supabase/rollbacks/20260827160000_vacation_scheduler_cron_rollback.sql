-- Deterministic rollback for
-- supabase/migrations/20260827160000_vacation_scheduler_cron.sql
begin;

select cron.unschedule('vacation-scheduler')
where exists (select 1 from cron.job where jobname = 'vacation-scheduler');

commit;
