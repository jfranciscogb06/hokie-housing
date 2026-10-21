# Accounts and shared "I'm interested"

Students sign in with their VT Google account; on a listing they can add themselves to
"Interested students" so others looking at the same place can find roommates.
Browsing never needs an account. Until this is set up, the shared features stay hidden.

## Set up (about 15 minutes, free tier)

1. **Supabase project:** create one at supabase.com. Copy the Project URL and the
   `anon` public key (Settings > API).
2. **Database rules:** open the SQL editor and run `backend/schema.sql`.
3. **Google sign-in:**
   - In Google Cloud Console create an OAuth client (type: Web application).
     Authorized redirect URI: `https://<project>.supabase.co/auth/v1/callback`.
   - In Supabase: Authentication > Providers > Google, paste the client ID and secret.
   - Authentication > URL Configuration: set Site URL to your site
     (e.g. `https://hokiehousing.com`) and add `http://localhost:8788` for testing.
4. **Turn it on:** in `index.html`, fill in `BACKEND.supabaseUrl` and `BACKEND.supabaseKey`.
   The anon key is meant to be public; the database rules are what protect the data.

## What the rules enforce (`schema.sql`)

- Only signed-in `@vt.edu` accounts can read the list. Anonymous visitors and other
  Google accounts see nothing. (The `hd=vt.edu` sign-in hint is just a hint; this is the check.)
- A student can only add, edit or remove **their own** entry.
- Email is shared only if the student ticks "Let interested students email me", and it
  must be the address they signed in with. Otherwise others see name, year, major,
  budget and note, with no contact details.
- Field lengths are capped (note: 280 characters).

These were tested against a local Postgres with Supabase's `auth.uid()`/`auth.jwt()`:
impersonating another user, faking an email, non-VT sign-ins, anonymous reads, and
editing/deleting someone else's entry are all rejected.

## Privacy

A student's name and the details they enter are shown to other signed-in VT students on
listings they joined; their email only with the opt-in. The page says this before they add themselves. Removing yourself deletes the row.
Deleting the auth user deletes their entries (`on delete cascade`).
