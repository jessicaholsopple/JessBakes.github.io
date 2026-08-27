-- Deterministic rollback of 20260827090000_vacation_periods_schema.sql.
--
-- Drops the table (cascades its own trigger/index/policies/column
-- grants). No other table is touched -- `email_campaigns` only had an
-- outbound nullable FK reference removed, nothing on that table
-- changes shape.
begin;

drop table if exists public.vacation_periods;
drop function if exists public.set_vacation_periods_updated_at();

commit;
