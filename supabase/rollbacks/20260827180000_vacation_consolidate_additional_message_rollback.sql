-- Deterministic rollback of 20260827180000_vacation_consolidate_additional_message.sql.
--
-- The merge itself (appending email_closing's text into email_intro)
-- cannot be un-merged character-for-character once concatenated, but
-- no data was deleted -- email_closing's original content is still
-- sitting in that column untouched. This rollback only removes the
-- descriptive comments; it deliberately does NOT attempt to strip the
-- merged text back out of email_intro (there is no reliable way to
-- know where the boundary was for rows edited after the migration
-- ran), since guessing and truncating text would risk destroying real
-- admin-authored content -- the opposite of this migration's purpose.
begin;

comment on column public.vacation_periods.email_intro is null;
comment on column public.vacation_periods.email_closing is null;

commit;
