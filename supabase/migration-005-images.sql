-- Migration 005: image storage (roadmap item 46)
--
-- Images pasted into a rem are stored on the device in IndexedDB and copied to
-- a private Storage bucket so your other devices can fetch them. Each image is
-- one object at `<your user id>/<image id>`, and these policies let a signed-in
-- user read and write only objects under their own id.
--
-- Until this has been run, images still work on the device they were pasted on;
-- the sidebar just says images aren't syncing yet. Safe to run more than once.

insert into storage.buckets (id, name, public)
values ('images', 'images', false)
on conflict (id) do nothing;

drop policy if exists "Users read their own images" on storage.objects;
create policy "Users read their own images"
  on storage.objects for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users upload their own images" on storage.objects;
create policy "Users upload their own images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);

-- `upsert: true` on upload is an update when the object already exists.
drop policy if exists "Users replace their own images" on storage.objects;
create policy "Users replace their own images"
  on storage.objects for update to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users delete their own images" on storage.objects;
create policy "Users delete their own images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
