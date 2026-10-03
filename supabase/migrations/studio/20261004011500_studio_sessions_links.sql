-- OrbitFS Studio migration: persistence required by Studio MCP sessions
-- and document links.

create table if not exists public.studio_sessions (
  id text primary key default gen_random_uuid()::text,
  workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
  session_type text not null default 'standard',
  title text not null default '',
  status text not null default 'active',
  draft_content text not null default '',
  owner_user_id text not null,
  created_by_user_id text,
  created_by text,
  settings_json jsonb not null default '{}'::jsonb,
  document_id text references public.studio_documents(id) on delete set null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_studio_sessions_workspace_owner_updated
  on public.studio_sessions(workspace_id, owner_user_id, updated_at desc);
create index if not exists idx_studio_sessions_workspace_owner_status
  on public.studio_sessions(workspace_id, owner_user_id, status);

create table if not exists public.studio_links (
  id text primary key default gen_random_uuid()::text,
  workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
  document_id text not null references public.studio_documents(id) on delete cascade,
  target_type text not null default 'document',
  target_id text not null,
  relation text not null default 'related',
  metadata_json jsonb not null default '{}'::jsonb,
  created_by_user_id text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_studio_links_workspace_document_created
  on public.studio_links(workspace_id, document_id, created_at);
create index if not exists idx_studio_links_target
  on public.studio_links(workspace_id, target_type, target_id);

alter table public.studio_sessions enable row level security;
alter table public.studio_links enable row level security;

revoke all on table public.studio_sessions from anon, authenticated;
revoke all on table public.studio_links from anon, authenticated;
grant select, insert, update, delete on table public.studio_sessions to service_role;
grant select, insert, update, delete on table public.studio_links to service_role;

notify pgrst, 'reload schema';
