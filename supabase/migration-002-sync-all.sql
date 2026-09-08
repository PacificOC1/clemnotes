-- Migration 002 — sync definitions, folders and flashcards
--
-- Run this in Supabase → SQL Editor → New query if you already ran the
-- original schema.sql (which only created `nodes`). It is safe to run more
-- than once: every statement is guarded with IF NOT EXISTS.
--
-- Until you run it, the app still syncs your notes fine — the sidebar will
-- just tell you which tables are missing.

-- 1. New columns on the existing nodes table for flashcard state.
alter table public.nodes add column if not exists "isCard" boolean not null default false;
alter table public.nodes add column if not exists "cardDirection" text not null default 'forward';

-- 2. Dictionary entries.
create table if not exists public.dictionary (
  id text primary key,
  "userId" uuid references auth.users not null,
  word text not null,
  "displayWord" text not null,
  definition text not null default '',
  "deletedAt" bigint,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);
create index if not exists dictionary_user_id_idx on public.dictionary ("userId");

-- 3. Sidebar folders.
create table if not exists public.folders (
  id text primary key,
  "userId" uuid references auth.users not null,
  name text not null default '',
  "pageIds" text[] not null default '{}',
  "order" double precision not null default 0,
  collapsed boolean not null default false,
  "deletedAt" bigint,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);
create index if not exists folders_user_id_idx on public.folders ("userId");

-- 4. Flashcard scheduling state.
create table if not exists public.cards (
  id text primary key,
  "userId" uuid references auth.users not null,
  "nodeId" text not null,
  kind text not null,
  "clozeIndex" integer,
  "easeFactor" double precision not null default 2.5,
  interval double precision not null default 0,
  repetitions integer not null default 0,
  lapses integer not null default 0,
  "dueAt" bigint not null,
  "lastReviewedAt" bigint,
  suspended boolean not null default false,
  "deletedAt" bigint,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);
create index if not exists cards_user_id_idx on public.cards ("userId");
create index if not exists cards_due_idx on public.cards ("userId", "dueAt");

-- 5. Row Level Security on the three new tables.
alter table public.dictionary enable row level security;
alter table public.folders enable row level security;
alter table public.cards enable row level security;

drop policy if exists "Users manage their own dictionary" on public.dictionary;
create policy "Users manage their own dictionary"
  on public.dictionary for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");

drop policy if exists "Users manage their own folders" on public.folders;
create policy "Users manage their own folders"
  on public.folders for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");

drop policy if exists "Users manage their own cards" on public.cards;
create policy "Users manage their own cards"
  on public.cards for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");
