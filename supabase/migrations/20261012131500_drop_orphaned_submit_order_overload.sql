-- ============================================================
-- Cleanup: drop an orphaned, pre-existing submit_order() overload
-- discovered while applying this session's finished-stock migrations
-- live -- not part of the finished-product freezer stock feature
-- itself, but found during verification and fixed here because it is
-- a genuine, currently-exploitable validation bypass.
--
-- `create or replace function` only replaces a function whose
-- argument TYPE list matches exactly; it is not keyed on name alone.
-- 20260831090000_order_server_side_validation.sql moved
-- p_preferred_contact from its old required, 4th position (text) to
-- an optional, LAST position (text default 'email'). That changed the
-- positional type signature (...,text,text,date,... vs
-- ...,text,date,text,...), so instead of replacing the previous
-- function in place, it silently created a SECOND overload --
-- orphaning the original 9-argument version
-- (p_customer_name, p_customer_email, p_customer_phone,
--  p_preferred_contact, p_order_type, p_event_date, p_notes,
--  p_subtotal, p_items), which has NONE of that migration's
-- server-side availability/price validation, and none of this
-- session's finished-stock eligibility checks either.
--
-- In practice js/cart.js's real RPC call never sends
-- p_preferred_contact, so PostgREST has only ever been able to
-- resolve it to the current, fully-validated overload (the old one is
-- missing a required, non-defaulted argument in that call shape) --
-- confirmed live via pg_proc that exactly one overload's source
-- contains the finished-stock checks and it is the one with
-- p_order_type in 4th position, matching every live migration file.
-- But the old, unvalidated overload is still independently callable
-- by anyone who explicitly supplies p_preferred_contact as a named
-- RPC argument, so it is dropped outright here rather than left as a
-- live bypass of both the 20260831 and 20261012 validation work.
-- ============================================================
begin;

drop function if exists public.submit_order(
  text, text, text, text, text, date, text, numeric, jsonb
);

commit;
