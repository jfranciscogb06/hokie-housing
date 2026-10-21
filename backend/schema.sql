-- Hokie Housing shared data (Supabase). Run once in the Supabase SQL editor.
-- Only signed-in @vt.edu accounts can see the list; each student can only
-- create, change or remove their own entry.

create table if not exists public.interests (
  listing_id   text        not null check (char_length(listing_id) between 1 and 40),
  user_id      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  listing_name text        check (char_length(listing_name) <= 200),
  name         text        not null check (char_length(name) between 1 and 80),
  -- Shared only if the student opts in ("Let interested students email me"); must be their own sign-in email.
  contact_email text       check (char_length(contact_email) <= 120),
  year         text        check (char_length(year) <= 20),
  major        text        check (char_length(major) <= 80),
  budget       text        check (char_length(budget) <= 40),
  roommates    boolean     not null default true,
  note         text        check (char_length(note) <= 280),
  at           timestamptz not null default now(),
  primary key (listing_id, user_id)
);

alter table public.interests enable row level security;

-- Google sign-in requests the vt.edu domain, but that is only a hint to Google;
-- this check is what actually enforces it.
create or replace function public.is_vt_user() returns boolean
  language sql stable
  as $$ select coalesce(auth.jwt() ->> 'email', '') ilike '%@vt.edu' $$;

drop policy if exists "VT students can read" on public.interests;
drop policy if exists "Students add their own entry" on public.interests;
drop policy if exists "Students edit their own entry" on public.interests;
drop policy if exists "Students remove their own entry" on public.interests;

create policy "VT students can read" on public.interests
  for select to authenticated using (public.is_vt_user());

create policy "Students add their own entry" on public.interests
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_vt_user() and (contact_email is null or contact_email = auth.jwt() ->> 'email'));

create policy "Students edit their own entry" on public.interests
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_vt_user() and (contact_email is null or contact_email = auth.jwt() ->> 'email'));

create policy "Students remove their own entry" on public.interests
  for delete to authenticated using (user_id = auth.uid());

-- Nothing for anonymous visitors.
revoke all on public.interests from anon;
grant select, insert, update, delete on public.interests to authenticated;
