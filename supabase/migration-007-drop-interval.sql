-- Migration 007: drop the old cards."interval" column (roadmap item 27)
--
-- Only after every device you use has updated to a version that writes
-- "intervalDays" (see migration-006). A device still on an older version would
-- fail to sync its flashcard scheduling after this. Safe to run more than once.

drop trigger if exists cards_sync_interval_days on public.cards;
drop function if exists public.cards_sync_interval_days();
alter table public.cards drop column if exists "interval";
