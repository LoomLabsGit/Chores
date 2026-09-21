-- Both partners have exactly the same access. There is no "admin" who can do more.
--
-- The only place the database gave the household creator extra power was the rewards shop: adding, editing
-- and retiring a reward required is_admin. Every other table and function already worked for either partner.
-- The shop policies now only ask that the reward belongs to your own household, like everything else.
--
-- profiles.is_admin stays as a plain marker of who created the household (it decides the colour each person is
-- shown in, and which side of a joint challenge's counts is theirs). It grants nothing. The helper that checked
-- it is dropped so nothing can rely on it again.
--
-- Changes two policies and drops one function. Run 0001-0013 first.

drop policy rewards_insert on public.rewards;
drop policy rewards_update on public.rewards;

create policy rewards_insert on public.rewards for insert to authenticated
  with check (household_id = public.current_household_id());
create policy rewards_update on public.rewards for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

drop function public.is_household_admin();

comment on column public.profiles.is_admin is
  'Marks who created the household (colour A, side "a" of a joint challenge). Grants no extra rights.';
