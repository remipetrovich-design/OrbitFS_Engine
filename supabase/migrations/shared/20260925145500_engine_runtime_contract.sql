-- OrbitFS Update migration: shared Engine runtime helper contract.
-- Safe for rebuilt Base databases. Legacy 2026-09-08 flat migrations are frozen
-- and intentionally not replayed against current customer databases.

create or replace function public.orbitfs_touch_addon_request(
  p_addon_id text,
  p_min_interval_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  changed integer;
begin
  if not private.orbitfs_server_secret_valid() then
    raise exception 'OrbitFS server authorization required' using errcode='42501';
  end if;

  update public.orbitfs_addons
     set runtime = coalesce(runtime,'{}'::jsonb)
         || jsonb_build_object('lastRequestAt',now()),
         updated_at = now()
   where id = p_addon_id
     and coalesce((runtime->>'lastRequestAt')::timestamptz,'epoch'::timestamptz)
       <= now() - make_interval(secs => greatest(1,coalesce(p_min_interval_seconds,30)));

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

revoke all on function public.orbitfs_touch_addon_request(text,integer) from public;
grant execute on function public.orbitfs_touch_addon_request(text,integer) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
