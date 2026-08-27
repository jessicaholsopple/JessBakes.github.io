-- Deterministic rollback of 20260827094500_vacation_eligible_subscribers_fn.sql.
begin;

drop function if exists public.vacation_eligible_subscribers(uuid);

commit;
