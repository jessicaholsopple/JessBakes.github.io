-- ============================================================
-- Consolidates the confusing "Introduction" + "Closing text" pair
-- into a single admin-facing "Additional message" field, reusing the
-- existing `email_intro` column (per the request: reuse rather than
-- add duplicate storage) -- `email_closing` is deprecated in place,
-- not dropped, so no historical data is destroyed and a rollback
-- stays trivial.
--
-- Data-safety: for any row where `email_closing` has real content,
-- merge it into `email_intro` (appended with a blank line if intro
-- also has content, otherwise it simply becomes the intro) rather
-- than discarding it. Verified against the live table before writing
-- this: the one existing row has both fields NULL, so this is a
-- no-op today -- written generally correct regardless, since the
-- requirement is that no admin-authored text is ever silently lost
-- by this change, now or for any future row.
-- ============================================================
begin;

update public.vacation_periods
set email_intro = case
  when coalesce(btrim(email_intro), '') = '' then email_closing
  else email_intro || E'\n\n' || email_closing
end
where coalesce(btrim(email_closing), '') <> '';

comment on column public.vacation_periods.email_intro is
  'Admin-facing "Additional message" -- freeform text shown in the reopening email directly under the standard "We''re back..." sentence. Sanitized (paragraph breaks preserved, no HTML) at render time. Column name kept as email_intro for schema stability; the UI label is "Additional message".';

comment on column public.vacation_periods.email_closing is
  'Deprecated: no longer written or read by the app (its content, if any, was merged into email_intro by 20260827180000). Kept only so no historical data is lost; safe to ignore.';

commit;
