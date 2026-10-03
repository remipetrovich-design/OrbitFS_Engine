-- OrbitFS MCP migration: expose the MCP OAuth token -> OrbitFS user
-- relationship required by the Engine PostgREST query.
--
-- Historical Base/MCP schemas created mcp_oauth_tokens.user_id without a
-- foreign key. MCP runtime authentication embeds orbitfs_users through the
-- stable constraint name below, so the relationship must exist in PostgreSQL.
-- NOT VALID preserves historical installations with any legacy orphan rows
-- while enforcing the relationship for new/updated token rows.

create index if not exists idx_mcp_oauth_tokens_user_id
  on public.mcp_oauth_tokens(user_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'mcp_oauth_tokens'
      and c.conname = 'mcp_oauth_tokens_user_id_fkey'
      and c.contype = 'f'
  ) then
    alter table public.mcp_oauth_tokens
      add constraint mcp_oauth_tokens_user_id_fkey
      foreign key (user_id)
      references public.orbitfs_users(id)
      on delete cascade
      not valid;
  end if;
end
$$;

notify pgrst, 'reload schema';
