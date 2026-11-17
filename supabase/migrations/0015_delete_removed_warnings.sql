-- 0015: removed warnings are deleted for good (owner, 17 Nov 2026), not kept struck through.
-- The bot still needs the row for its #server-logs post and DM, so the row is deleted the moment the bot marks it
-- posted (revoke_posted = true). No bot change needed.

create or replace function public.delete_posted_removed_warning() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.mod_cases where id = new.id;
  return null;
end $$;

drop trigger if exists delete_posted_removed_warning on public.mod_cases;
create trigger delete_posted_removed_warning after update of revoke_posted on public.mod_cases
  for each row when (new.revoke_posted and new.revoked_at is not null)
  execute function public.delete_posted_removed_warning();

-- Removed warnings the bot has already posted.
delete from public.mod_cases where revoked_at is not null and revoke_posted;
