-- "Manage chores": create, edit and delete library chores in one place, pushing changes across the board.
--
-- Editing a library chore updates the chore everywhere it is used, but only for the fields you
-- actually changed (so a one-off tweak on a single day survives an unrelated edit):
--   * name changed      -> every scheduled copy (finished ones too) and every repeating series
--   * time / tax changed -> every UNFINISHED copy and every repeating series (future days follow)
--   * category changed  -> the library only
-- Finished chores never have their logged time or points touched: that reward was already paid out.
--
-- Deleting archives the library chore (history keeps working), stops any repeating series, and
-- optionally removes the unfinished copies from the calendar. Finished chores are always kept.
--
-- Adds three functions; changes nothing that exists. Run 0001-0007 first.

-- ---------------------------------------------------------------------------
-- Usage counts for the manage screen: one row per live library chore.
-- ---------------------------------------------------------------------------
create function public.library_usage()
returns table (library_id uuid, open_count integer, done_count integer, repeating_count integer)
language sql stable security definer set search_path = '' as $$
  select l.id,
         (count(i.id) filter (where not i.is_completed))::integer,
         (count(i.id) filter (where i.is_completed))::integer,
         (select count(*) from public.chore_series s
           where s.chore_id = l.id and (s.end_date is null or s.end_date >= current_date))::integer
  from public.chore_library l
  left join public.chore_instances i on i.chore_id = l.id
  where l.household_id = public.current_household_id()
    and not coalesce(l.is_archived, false)
  group by l.id
$$;

revoke all on function public.library_usage() from public, anon;
grant execute on function public.library_usage() to authenticated;

-- ---------------------------------------------------------------------------
-- Create
-- ---------------------------------------------------------------------------
create function public.create_library_chore(
  p_title text, p_category text, p_duration integer, p_tax integer
) returns public.chore_library
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  new_title text := trim(coalesce(p_title, ''));
  new_category text := coalesce(nullif(trim(coalesce(p_category, '')), ''), 'General');
  result public.chore_library;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if new_title = '' then raise exception 'Give the chore a name'; end if;
  if char_length(new_title) > 60 then raise exception 'Keep the name to 60 characters or fewer'; end if;
  if char_length(new_category) > 30 then raise exception 'Keep the category to 30 characters or fewer'; end if;
  if p_duration is null or p_duration < 5 or p_duration > 1440 or p_duration % 5 <> 0 then
    raise exception 'Duration must be a multiple of 5 minutes, between 5 and 1440';
  end if;
  if p_tax is null or p_tax < 0 or p_tax > 50 then raise exception 'Chore tax must be between 0 and 50'; end if;
  if exists (
    select 1 from public.chore_library
    where household_id = hh and not coalesce(is_archived, false) and lower(title) = lower(new_title)
  ) then
    raise exception 'You already have a chore called "%"', new_title;
  end if;

  -- last_used_at stays null so "Recent" only shows chores that have really been scheduled.
  insert into public.chore_library (household_id, title, category, default_duration, chore_tax, last_used_at)
  values (hh, new_title, new_category, p_duration, p_tax, null)
  returning * into result;
  return result;
end $$;

revoke all on function public.create_library_chore(text, text, integer, integer) from public, anon;
grant execute on function public.create_library_chore(text, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Edit + push across the board
-- ---------------------------------------------------------------------------
create function public.update_library_chore(
  p_chore_id uuid, p_title text, p_category text, p_duration integer, p_tax integer
) returns table (n_open integer, n_series integer)
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  lib public.chore_library;
  new_title text := trim(coalesce(p_title, ''));
  new_category text := coalesce(nullif(trim(coalesce(p_category, '')), ''), 'General');
  title_changed boolean;
  time_changed boolean;
  tax_changed boolean;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if new_title = '' then raise exception 'Give the chore a name'; end if;
  if char_length(new_title) > 60 then raise exception 'Keep the name to 60 characters or fewer'; end if;
  if char_length(new_category) > 30 then raise exception 'Keep the category to 30 characters or fewer'; end if;
  if p_duration is null or p_duration < 5 or p_duration > 1440 or p_duration % 5 <> 0 then
    raise exception 'Duration must be a multiple of 5 minutes, between 5 and 1440';
  end if;
  if p_tax is null or p_tax < 0 or p_tax > 50 then raise exception 'Chore tax must be between 0 and 50'; end if;

  select * into lib from public.chore_library
  where id = p_chore_id and household_id = hh and not coalesce(is_archived, false)
  for update;
  if not found then raise exception 'Chore not found'; end if;

  if exists (
    select 1 from public.chore_library
    where household_id = hh and id <> lib.id and not coalesce(is_archived, false)
      and lower(title) = lower(new_title)
  ) then
    raise exception 'You already have a chore called "%"', new_title;
  end if;

  -- Each field is compared with the library's own value, so only what you changed is pushed and
  -- re-saving an unchanged chore is a no-op.
  title_changed := new_title is distinct from lib.title;
  time_changed := p_duration is distinct from lib.default_duration;
  tax_changed := p_tax is distinct from lib.chore_tax;

  update public.chore_library
  set title = new_title, category = new_category, default_duration = p_duration, chore_tax = p_tax
  where id = lib.id;

  n_open := 0;
  n_series := 0;
  if not (title_changed or time_changed or tax_changed) then
    return next;
    return;
  end if;

  -- Unfinished copies: whatever changed follows the library.
  update public.chore_instances
  set title = case when title_changed then new_title else title end,
      estimated_duration = case when time_changed then p_duration else estimated_duration end,
      chore_tax = case when tax_changed then p_tax else chore_tax end
  where chore_id = lib.id and household_id = hh and not is_completed;
  get diagnostics n_open = row_count;

  -- Finished copies: only the name (the reward and logged time are history).
  if title_changed then
    update public.chore_instances set title = new_title
    where chore_id = lib.id and household_id = hh and is_completed;
  end if;

  -- Repeating series, so the days generated from now on carry the new values too.
  update public.chore_series
  set title = case when title_changed then new_title else title end,
      estimated_duration = case when time_changed then p_duration else estimated_duration end,
      chore_tax = case when tax_changed then p_tax else chore_tax end
  where chore_id = lib.id and household_id = hh and (end_date is null or end_date >= current_date);
  get diagnostics n_series = row_count;

  return next;
end $$;

revoke all on function public.update_library_chore(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.update_library_chore(uuid, text, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Delete
-- ---------------------------------------------------------------------------
create function public.delete_library_chore(p_chore_id uuid, p_remove_open boolean default false)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  hh uuid := public.current_household_id();
  lib public.chore_library;
  removed integer := 0;
begin
  if uid is null or hh is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

  select * into lib from public.chore_library
  where id = p_chore_id and household_id = hh and not coalesce(is_archived, false)
  for update;
  if not found then raise exception 'Chore not found'; end if;

  -- Archived, not deleted: finished chores, stats and rewards already earned keep pointing at it.
  update public.chore_library set is_archived = true where id = lib.id;

  -- A deleted chore must stop coming back: end every series at the last day already generated.
  update public.chore_series
  set end_date = least(coalesce(end_date, generated_through), generated_through)
  where chore_id = lib.id and household_id = hh and (end_date is null or end_date > generated_through);

  if p_remove_open then
    delete from public.chore_instances
    where chore_id = lib.id and household_id = hh and not is_completed;
    get diagnostics removed = row_count;
  end if;

  return removed;
end $$;

revoke all on function public.delete_library_chore(uuid, boolean) from public, anon;
grant execute on function public.delete_library_chore(uuid, boolean) to authenticated;
