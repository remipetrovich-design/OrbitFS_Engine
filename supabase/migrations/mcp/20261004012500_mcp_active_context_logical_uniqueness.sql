-- OrbitFS MCP migration: restore the logical active-context uniqueness
-- contract that historically came from the Base schema before component
-- ownership was split. MCP owns the table and therefore owns this index.

create unique index if not exists ux_mcp_active_contexts_logical_context
  on public.mcp_active_contexts(user_id,client_id,workspace_id,context_key);

notify pgrst, 'reload schema';
