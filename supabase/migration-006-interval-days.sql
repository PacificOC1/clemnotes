-- Migration 006: cards."interval" becomes cards."intervalDays" (roadmap item 27)
--
-- `interval` is a Postgres keyword, and the name didn't say what unit it held.
-- The app now reads and writes "intervalDays". Run this when you deploy the
-- version that expects it; until you do, flashcard *scheduling* stops syncing
-- (notes and everything else keep syncing, and the sidebar says why).
--
-- It is written so devices still running an older version keep working in the
-- meantime: the old column stays, and a trigger keeps the two in step whichever
-- one a device writes. Once every device has updated, run
-- `migration-007-drop-interval.sql` to remove the old column. Safe to run more
-- than once.

alter table public.cards add column if not exists "intervalDays" double precision;

update public.cards
set "intervalDays" = "interval"
where "intervalDays" is null;

alter table public.cards alter column "intervalDays" set default 0;
alter table public.cards alter column "intervalDays" set not null;

-- Whichever column a device wrote wins; the other follows.
create or replace function public.cards_sync_interval_days() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new."intervalDays" is null or (new."intervalDays" = 0 and coalesce(new."interval", 0) <> 0) then
      new."intervalDays" := coalesce(new."interval", 0);
    end if;
    new."interval" := new."intervalDays";
  else
    if new."intervalDays" is distinct from old."intervalDays" then
      new."interval" := new."intervalDays";
    elsif new."interval" is distinct from old."interval" then
      new."intervalDays" := new."interval";
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cards_sync_interval_days on public.cards;
create trigger cards_sync_interval_days
  before insert or update on public.cards
  for each row execute function public.cards_sync_interval_days();
