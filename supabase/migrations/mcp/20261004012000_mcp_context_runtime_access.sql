-- OrbitFS MCP migration: allow the restricted MCP runtime to execute the
-- Base-owned normalized active-context RPCs.
--
-- The functions are SECURITY INVOKER and mcp_active_contexts remains protected
-- by the Base runtime-secret RLS contract.

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.orbitfs_mcp_context_item_key(jsonb,integer)',
    'public.orbitfs_mcp_context_get(text,text,text,text)',
    'public.orbitfs_mcp_context_patch(text,text,text,text,jsonb,jsonb,jsonb)',
    'public.orbitfs_mcp_context_clear(text,text,text,text)'
  ]
  loop
    if to_regprocedure(signature) is null then
      raise exception 'Required OrbitFS Base MCP context function is missing: %', signature
        using errcode = '55000';
    end if;
    execute format('grant execute on function %s to anon, authenticated, service_role', signature);
  end loop;
end
$$;

notify pgrst, 'reload schema';
