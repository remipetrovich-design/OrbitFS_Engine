-- OrbitFS Shared Engine migration: allow the restricted Engine runtime to
-- execute Base-owned normalized Library state RPCs.
--
-- These functions are SECURITY INVOKER. Table access therefore remains subject
-- to the Base runtime-secret RLS policies; this only exposes the RPC entry
-- points to the anon/authenticated roles used by the Engine publishable key.

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.orbitfs_library_object_id(jsonb,integer)',
    'public.orbitfs_library_state_get(text)',
    'public.orbitfs_library_state_patch(text,jsonb,jsonb,jsonb)'
  ]
  loop
    if to_regprocedure(signature) is null then
      raise exception 'Required OrbitFS Base normalized-state function is missing: %', signature
        using errcode = '55000';
    end if;
    execute format('grant execute on function %s to anon, authenticated, service_role', signature);
  end loop;
end
$$;

notify pgrst, 'reload schema';
