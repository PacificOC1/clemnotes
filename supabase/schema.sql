-- Run this once in your Supabase project's SQL editor (Dashboard → SQL Editor → New query)
-- to set up the tables cloud sync needs. Column names intentionally match the
-- app's field names exactly (camelCase, quoted) so the sync code can
-- read/write rows with no field-name translation layer.
--
-- Already running an older version of this app? Don't run this file — run
-- `migration-002-sync-all.sql` instead, which adds the new tables and columns
-- to the schema you already have without touching your existing notes.

-- ---------------------------------------------------------------------------
-- nodes — every rem (page, bullet, portal) in the outliner
-- ---------------------------------------------------------------------------
create table public.nodes (
  id text primary key,
  "userId" uuid references auth.users not null,
  content text not null default '',
  "plainText" text not null default '',
  "parentId" text,
  "childrenIds" text[] not null default '{}',
  "order" double precision not null default 0,
  collapsed boolean not null default false,
  "isPage" boolean not null default false,
  "outboundLinks" text[] not null default '{}',
  "isPortal" boolean not null default false,
  "portalTargetId" text,
  "isCard" boolean not null default false,
  "cardDirection" text not null default 'forward',
  "deletedAt" bigint,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);

create index nodes_user_id_idx on public.nodes ("userId");

-- ---------------------------------------------------------------------------
-- dictionary — your saved word definitions
-- ---------------------------------------------------------------------------
create table public.dictionary (
  id text primary key,
  "userId" uuid references auth.users not null,
  word text not null,
  "displayWord" text not null,
  definition text not null default '',
  "deletedAt" bigint,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);

create index dictionary_user_id_idx on public.dictionary ("userId");

-- ---------------------------------------------------------------------------
-- folders — sidebar grouping for top-level pages
-- ---------------------------------------------------------------------------
create table public.folders (
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

create index folders_user_id_idx on public.folders ("userId");

-- ---------------------------------------------------------------------------
-- cards — SM-2 scheduling state, one row per flashcard
-- ---------------------------------------------------------------------------
create table public.cards (
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

create index cards_user_id_idx on public.cards ("userId");
create index cards_due_idx on public.cards ("userId", "dueAt");

-- ---------------------------------------------------------------------------
-- reviews — append-only log of every grade you have given
--
-- `cards` says where a card's schedule stands now; this says how it got there.
-- Rows are written once and never updated or deleted, which is why sync treats
-- this table differently from the rest. `deletedAt` exists only because the
-- sync contract expects it.
-- ---------------------------------------------------------------------------
create table public.reviews (
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

create index reviews_user_id_idx on public.reviews ("userId");
create index reviews_user_reviewed_idx on public.reviews ("userId", "reviewedAt");
create index reviews_card_idx on public.reviews ("userId", "cardId");

-- ---------------------------------------------------------------------------
-- Row Level Security: every user can only ever see/write their own rows.
-- ---------------------------------------------------------------------------
alter table public.nodes enable row level security;
alter table public.dictionary enable row level security;
alter table public.folders enable row level security;
alter table public.cards enable row level security;
alter table public.reviews enable row level security;

create policy "Users manage their own nodes"
  on public.nodes for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");

create policy "Users manage their own dictionary"
  on public.dictionary for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");

create policy "Users manage their own folders"
  on public.folders for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");

create policy "Users manage their own cards"
  on public.cards for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");

create policy "Users manage their own reviews"
  on public.reviews for all
  using (auth.uid() = "userId") with check (auth.uid() = "userId");

-- Note: by default Supabase requires email confirmation before sign-in
-- works. For quick personal testing you can turn this off under
-- Authentication → Providers → Email → "Confirm email" toggle.
