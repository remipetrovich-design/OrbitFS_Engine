-- OrbitFS MCP migration: persistent runtime status used by MCP system
-- status and administrator global-sync operations.

create table if not exists public.mcp_runtime_state (
  id smallint primary key default 1,
  mode text not null default 'cloud',
  workspace_addon_active boolean not null default false,
  connector_url text,
  service_status text not null default 'stopped',
  updated_at timestamptz not null default now(),
  constraint mcp_runtime_state_singleton check (id = 1)
);

insert into public.mcp_runtime_state(
  id, mode, workspace_addon_active, service_status, updated_at
)
values (1, 'cloud', false, 'stopped', now())
on conflict (id) do nothing;

alter table public.mcp_runtime_state enable row level security;
revoke all on table public.mcp_runtime_state from anon, authenticated;
grant select, insert, update, delete on table public.mcp_runtime_state to service_role;

notify pgrst, 'reload schema';
