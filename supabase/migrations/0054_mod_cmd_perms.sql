-- 0054: website mod actions follow the role editor's bot command permissions (Bravo, 18 Nov 2026; Charlie's review).
-- A warn/timeout/untimeout/kick/ban/unban asked for on the website now needs, as well as hosp.mod, that one of the
-- requester's roles may use that command (role_cmd_perms, 0053; executives always may), the same rule CareBeyond
-- Helper applies to the slash commands. role_cmd_perms is seeded from the same roles as hosp.mod, so nothing changes
-- today. In-game reports (source 'in_game') are unchanged.
create or replace function public.can_use_cmd(command text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (
    select 1 from public.my_roles() r join public.role_cmd_perms c on c.role_id = r.id where c.command = can_use_cmd.command)
$$;
revoke execute on function public.can_use_cmd(text) from public, anon;
grant execute on function public.can_use_cmd(text) to authenticated;

drop policy if exists mod_cases_report on public.mod_cases;
create policy mod_cases_report on public.mod_cases for insert to authenticated with check (
  public.has_hperm('hosp.mod') and moderator_discord_id = public.my_discord_id() and not posted and error is null and done_at is null
  and ((source = 'website' and status = 'pending' and target_discord_id is not null
        and action = any (array['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'])
        and (action <> 'timeout' or duration_minutes = any (array[10, 60, 360, 1440, 4320, 10080]))
        and public.can_use_cmd(action))
    or (source = 'in_game' and status = 'done' and target_discord_id is null)));
