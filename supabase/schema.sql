-- Run this once in your Supabase project's SQL editor (Dashboard → SQL Editor → New query)
-- to set up the table cloud sync needs. Column names intentionally match the
-- app's OutlinerNode fields exactly (camelCase, quoted) so the sync code can
-- read/write rows with no field-name translation layer.

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
  "deletedAt" bigint,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);

-- Speeds up the sync engine's per-user fetch.
create index nodes_user_id_idx on public.nodes ("userId");

-- Row Level Security: every user can only ever see/write their own rows.
alter table public.nodes enable row level security;

create policy "Users manage their own nodes"
  on public.nodes
  for all
  using (auth.uid() = "userId")
  with check (auth.uid() = "userId");

-- Note: by default Supabase requires email confirmation before sign-in
-- works. For quick personal testing you can turn this off under
-- Authentication → Providers → Email → "Confirm email" toggle.
