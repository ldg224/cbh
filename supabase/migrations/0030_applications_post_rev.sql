-- 0030: guard for the bot's post_dirty clear (Alpha; asked by Charlie/Bravo). Additive.
-- form_submissions.post_rev goes up by one every time something on the #form-submissions post changes (status,
-- stage or the decision note), so the bot only clears post_dirty when post_rev still matches what it read.
alter table public.form_submissions add column if not exists post_rev integer not null default 0;

create or replace function public.app_post_rev()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.post_dirty and (new.status, new.stage, new.review_note) is distinct from (old.status, old.stage, old.review_note) then
    new.post_rev := old.post_rev + 1;
  end if;
  return new;
end $$;
drop trigger if exists app_post_rev on public.form_submissions;
create trigger app_post_rev before update on public.form_submissions for each row execute function public.app_post_rev();
revoke execute on function public.app_post_rev() from public, anon, authenticated;
