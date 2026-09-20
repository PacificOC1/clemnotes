-- Migration 003 — the review log
--
-- Run this in Supabase → SQL Editor → New query if you already have the app's
-- other tables. Safe to run more than once: every statement is guarded.
--
-- Until you run it, everything else still syncs — the sidebar will just list
-- `reviews` as missing, and your review history stays on this device only.
--
-- Unlike the other tables, this one is append-only: a row is written once when
-- you grade a card and is never updated or deleted afterwards. `deletedAt` is
-- present only because the sync code expects every synced table to have it.

create table if not exists public.reviews (
  id text primary key,
  "userId" uuid references auth.users not null,
  "cardId" text not null,
  "nodeId" text not null,
  kind text not null,
  grade integer not null,
  "reviewedAt" bigint not null,
  "scheduledFor" bigint not null,
  "elapsedMs" bigint,
  state text not null,
  "intervalBefore" double precision not null default 0,
  "intervalAfter" double precision not null default 0,
  "easeBefore" double precision not null default 2.5,
  "easeAfter" double precision not null default 2.5,
  "repetitionsBefore" integer not null default 0,
  "lapsesBefore" integer not null default 0,
  "deletedAt" bigint,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);

create index if not exists reviews_user_id_idx on public.reviews ("userId");
-- Every statistic reads a date range for one user, and sync fetches that
-- user's ids; both are served by this.
create index if not exists reviews_user_reviewed_idx on public.reviews ("userId", "reviewedAt");
create index if not exists reviews_card_idx on public.reviews ("userId", "cardId");

alter table public.reviews enable row level security;

drop policy if exists "Users manage their own reviews" on public.reviews;
create policy "Users manage their own reviews"
  on public.reviews for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");
