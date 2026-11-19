-- 0090 down: remove the Chart's shift hook (the shifts table is otherwise untouched).
drop trigger if exists chart_shift_hook on public.shifts;
drop function if exists public.chart_shift_hook();
