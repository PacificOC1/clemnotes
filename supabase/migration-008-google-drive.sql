-- Migration 008: Google Drive connection (images & PDFs in Google Drive)
--
-- Only needed if you keep images and PDFs in Google Drive. Holds each
-- person's Google *refresh token* — the long-lived part of a Google sign-in —
-- for the `google-drive` Edge Function (supabase/functions/google-drive).
--
-- Row-level security is on and there are deliberately NO policies: the app
-- (anon key + your login) can't read, write or even see these rows. Only the
-- Edge Function can, with the service key, and it only ever hands the browser
-- short-lived access tokens. Safe to run more than once.

create table if not exists public.google_drive_tokens (
  "userId" uuid primary key references auth.users on delete cascade,
  "refreshToken" text not null,
  email text,
  "updatedAt" bigint not null
);

alter table public.google_drive_tokens enable row level security;

-- Belt and braces: no table privileges for the roles the browser uses.
revoke all on public.google_drive_tokens from anon, authenticated;
