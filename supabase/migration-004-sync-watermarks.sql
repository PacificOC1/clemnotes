-- Migration 004: indexes for incremental sync (roadmap item 14)
--
-- The client used to pull every row of every table on every poll and diff in
-- memory. It now asks only for rows changed since its last sync:
--
--   select * from nodes where "userId" = $1 and "updatedAt" > $2
--
-- Without an index on that pair, Postgres answers it with a scan of the user's
-- whole table — which is the same work as before, just done on the server
-- instead of over the wire. These make it an index range scan.
--
-- Nothing in the app depends on this migration: sync is already correct
-- without it, and only gets slower as a notebook grows. Safe to run more than
-- once, and safe to run while the app is in use.
--
-- The `reviews` table already has ("userId", "reviewedAt"); it needs
-- ("userId", "updatedAt") too, because the append-only path now pages through
-- ids by `updatedAt` rather than reading them all.

create index if not exists nodes_user_updated_idx on public.nodes ("userId", "updatedAt");
create index if not exists dictionary_user_updated_idx on public.dictionary ("userId", "updatedAt");
create index if not exists folders_user_updated_idx on public.folders ("userId", "updatedAt");
create index if not exists cards_user_updated_idx on public.cards ("userId", "updatedAt");
create index if not exists reviews_user_updated_idx on public.reviews ("userId", "updatedAt");
