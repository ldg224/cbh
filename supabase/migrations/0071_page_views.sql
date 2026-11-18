-- 0071: anonymous page views (Alpha). Owner approved 18 Nov 2026, for the site rethink: "when do people use it, and what for".
-- Stored as COUNTS only: (hour, route pattern, phone/desktop, staff yes/no) -> views. No user id, no IP, no exact time, no
-- per-view rows. Routes are patterns (ids replaced, e.g. directors/:dept/courses/:id). Inserts only through page_view(); owners
-- read aggregates through page_view_report().

create table if not exists public.page_view_counts (
  hour      timestamptz not null,                       -- truncated to the hour
  route     text not null check (route ~ '^[a-z0-9:_/-]{1,80}$'),
  device    text not null check (device in ('phone', 'desktop')),
  is_staff  boolean not null,
  views     integer not null default 0,
  primary key (hour, route, device, is_staff)
);
alter table public.page_view_counts enable row level security;
revoke all on public.page_view_counts from anon, authenticated;

-- Rate limit: a per-person counter for the CURRENT hour only, keyed by a hash that changes every hour (it can't be joined to the
-- counts table, and rows older than 2 hours are deleted on every call). 120 views an hour is plenty for real browsing.
create table if not exists public.page_view_limits (
  key        text primary key,
  hour       timestamptz not null,
  n          integer not null default 0
);
alter table public.page_view_limits enable row level security;
revoke all on public.page_view_limits from anon, authenticated;

-- Normalise a route to a pattern: lowercase, at most 4 segments, ids (numbers, uuids) -> :id, the department after directors -> :dept.
create or replace function public.page_view_route(raw text)
returns text language plpgsql immutable set search_path = '' as $$
declare segs text[]; r text[] := '{}'; s text; i int := 0;
begin
  segs := string_to_array(lower(regexp_replace(coalesce(raw, ''), '^[#/]+', '')), '/');
  foreach s in array segs loop
    i := i + 1;
    exit when i > 4;
    continue when s = '';
    if s ~ '^[0-9]+$' or s ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then s := ':id';
    elsif i = 2 and segs[1] = 'directors' then s := ':dept';
    elsif s !~ '^[a-z0-9_-]{1,30}$' then s := ':x';
    end if;
    r := r || s;
  end loop;
  return coalesce(nullif(array_to_string(r, '/'), ''), 'home');
end $$;

create or replace function public.page_view(route text, device text)
returns void language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); h timestamptz := date_trunc('hour', now()); k text; n int; staff boolean;
begin
  if me is null then return; end if;                        -- signed-in members only; silently ignore everything else
  if device is null or device not in ('phone', 'desktop') then return; end if;
  delete from public.page_view_limits where hour < h - interval '2 hours';
  k := md5(me || ':' || h::text || ':cbh-pv');
  insert into public.page_view_limits (key, hour, n) values (k, h, 1)
  on conflict (key) do update set n = page_view_limits.n + 1 returning page_view_limits.n into n;
  if n > 120 then return; end if;
  staff := coalesce((select m.is_staff from public.members m where m.discord_id = me), false);
  insert into public.page_view_counts (hour, route, device, is_staff, views) values (h, public.page_view_route(page_view.route), page_view.device, staff, 1)
  on conflict on constraint page_view_counts_pkey do update set views = page_view_counts.views + 1;
end $$;

-- Owners: views by route, by hour of day (US Eastern and Sydney), by weekday and by device, for the last N days.
create or replace function public.page_view_report(days int default 14)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := now() - make_interval(days => least(greatest(coalesce(days, 14), 1), 365));
begin
  if not public.is_exec() then raise exception 'Page view numbers are for owners.'; end if;
  return jsonb_build_object(
    'since', since, 'total', (select coalesce(sum(views), 0) from public.page_view_counts where hour >= since),
    'by_device', (select coalesce(jsonb_object_agg(device, v), '{}'::jsonb) from (select device, sum(views) v from public.page_view_counts where hour >= since group by 1) x),
    'by_route', (select coalesce(jsonb_agg(jsonb_build_object('route', route, 'views', v, 'phone', p, 'desktop', d, 'staff', st) order by v desc), '[]'::jsonb) from (
        select route, sum(views) v, sum(views) filter (where device = 'phone') p, sum(views) filter (where device = 'desktop') d, sum(views) filter (where is_staff) st
        from public.page_view_counts where hour >= since group by 1) x),
    'by_hour_et', (select coalesce(jsonb_agg(jsonb_build_object('hour', hr, 'views', v) order by hr), '[]'::jsonb) from (
        select extract(hour from hour at time zone 'America/New_York')::int hr, sum(views) v from public.page_view_counts where hour >= since group by 1) x),
    'by_hour_sydney', (select coalesce(jsonb_agg(jsonb_build_object('hour', hr, 'views', v) order by hr), '[]'::jsonb) from (
        select extract(hour from hour at time zone 'Australia/Sydney')::int hr, sum(views) v from public.page_view_counts where hour >= since group by 1) x),
    'by_weekday_et', (select coalesce(jsonb_agg(jsonb_build_object('day', dn, 'views', v) order by dw), '[]'::jsonb) from (
        select extract(isodow from hour at time zone 'America/New_York')::int dw, to_char(hour at time zone 'America/New_York', 'Dy') dn, sum(views) v
        from public.page_view_counts where hour >= since group by 1, 2) x),
    'during_live_session', (select coalesce(sum(c.views), 0) from public.page_view_counts c where c.hour >= since and exists (
        select 1 from public.sessions s where s.started_at is not null and s.started_at < c.hour + interval '1 hour' and coalesce(s.ended_at, now()) > c.hour)));
end $$;

revoke execute on function public.page_view_route(text) from public, anon;
revoke execute on function public.page_view(text, text) from public, anon;
grant execute on function public.page_view(text, text) to authenticated;
revoke execute on function public.page_view_report(int) from public, anon;
grant execute on function public.page_view_report(int) to authenticated;
