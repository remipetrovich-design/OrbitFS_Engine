-- OrbitFS MCP component baseline.
-- This adopts the historical MCP schema that older Base releases created.
-- It is intentionally idempotent so existing installations keep their data
-- while new installations receive MCP persistence only when MCP is deployed.

create extension if not exists pgcrypto;

create table if not exists public.mcp_projects (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 name text not null,
 description text not null default '',
 created_by_user_id text,
 created_by_username text,
 config jsonb not null default '{}'::jsonb,
 status text not null default 'active',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.mcp_project_items (
 id text primary key default gen_random_uuid()::text,
 project_id text not null references public.mcp_projects(id) on delete cascade,
 item_type text not null default 'file',
 item_path text not null default '',
 missing boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.mcp_context_bundles (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 name text not null,
 description text not null default '',
 version integer not null default 1,
 enabled boolean not null default true,
 created_by_user_id text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.mcp_context_bundle_entries (
 id text primary key default gen_random_uuid()::text,
 bundle_id text not null references public.mcp_context_bundles(id) on delete cascade,
 entry_type text not null default 'file',
 item_path text not null default '',
 attachment_type text not null default 'path',
 profile_id text,
 profile_name text,
 knowledge_item_id text,
 knowledge_item_name text,
 load_mode text,
 recursive_flag boolean not null default false,
 required_flag boolean not null default true,
 priority integer not null default 100,
 sort_order integer not null default 0,
 created_at timestamptz not null default now()
);

create table if not exists public.mcp_context_bundle_dependencies (
 id text primary key default gen_random_uuid()::text,
 bundle_id text not null references public.mcp_context_bundles(id) on delete cascade,
 depends_on_bundle_id text not null references public.mcp_context_bundles(id) on delete cascade,
 required_flag boolean not null default true,
 sort_order integer not null default 0,
 created_at timestamptz not null default now()
);

create table if not exists public.mcp_project_context_bundles (
 id text primary key default gen_random_uuid()::text,
 project_id text not null references public.mcp_projects(id) on delete cascade,
 bundle_id text not null references public.mcp_context_bundles(id) on delete cascade,
 required_flag boolean not null default true,
 sort_order integer not null default 0,
 created_at timestamptz not null default now(),
 unique(project_id,bundle_id)
);

create table if not exists public.mcp_workspace_startup (
 workspace_id text primary key references public.orbitfs_workspaces(id) on delete cascade,
 strength text not null default 'medium',
 instructions text not null default '',
 ai_behaviour text not null default '',
 updated_by_user_id text,
 updated_at timestamptz not null default now()
);

create table if not exists public.mcp_workspace_startup_projects (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 project_id text not null references public.mcp_projects(id) on delete cascade,
 sort_order integer not null default 0,
 unique(workspace_id,project_id)
);

create table if not exists public.mcp_workspace_default_profiles (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 profile_id text not null,
 sort_order integer not null default 0,
 unique(workspace_id,profile_id)
);

create table if not exists public.mcp_workspace_default_profile_bundles (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 profile_bundle_id text not null,
 sort_order integer not null default 0,
 unique(workspace_id,profile_bundle_id)
);

create table if not exists public.mcp_workspace_default_items (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 item_type text not null default 'file',
 item_path text not null default '',
 recursive_flag boolean not null default false,
 missing boolean not null default false,
 sort_order integer not null default 0
);

create table if not exists public.mcp_workspace_preset_items (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 preset text not null,
 item_type text not null default 'file',
 item_path text not null default '',
 recursive_flag boolean not null default false,
 sort_order integer not null default 0
);

create table if not exists public.mcp_workspace_preset_profiles (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 preset text not null,
 profile_id text not null,
 sort_order integer not null default 0
);

create table if not exists public.mcp_workspace_preset_profile_bundles (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 preset text not null,
 profile_bundle_id text not null,
 sort_order integer not null default 0
);

create table if not exists public.mcp_workspace_preset_metadata (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 preset text not null,
 display_name text,
 description text,
 metadata jsonb not null default '{}'::jsonb,
 updated_by_user_id text,
 updated_at timestamptz not null default now(),
 unique(workspace_id,preset)
);

create table if not exists public.mcp_project_preset_items (
 id text primary key default gen_random_uuid()::text,
 project_id text not null references public.mcp_projects(id) on delete cascade,
 preset text not null,
 item_type text not null default 'file',
 item_path text not null default '',
 recursive_flag boolean not null default false,
 sort_order integer not null default 0
);

create table if not exists public.mcp_project_preset_profiles (
 id text primary key default gen_random_uuid()::text,
 project_id text not null references public.mcp_projects(id) on delete cascade,
 preset text not null,
 profile_id text not null,
 sort_order integer not null default 0
);

create table if not exists public.mcp_project_preset_profile_bundles (
 id text primary key default gen_random_uuid()::text,
 project_id text not null references public.mcp_projects(id) on delete cascade,
 preset text not null,
 profile_bundle_id text not null,
 sort_order integer not null default 0
);

create table if not exists public.mcp_project_preset_metadata (
 id text primary key default gen_random_uuid()::text,
 project_id text not null references public.mcp_projects(id) on delete cascade,
 preset text not null,
 display_name text,
 description text,
 metadata jsonb not null default '{}'::jsonb,
 updated_by_user_id text,
 updated_at timestamptz not null default now(),
 unique(project_id,preset)
);

create table if not exists public.mcp_project_preset_bundles (
 id text primary key default gen_random_uuid()::text,
 project_id text not null references public.mcp_projects(id) on delete cascade,
 preset text not null,
 bundle_id text not null references public.mcp_context_bundles(id) on delete cascade,
 required_flag boolean not null default true,
 sort_order integer not null default 0
);

create table if not exists public.mcp_workspace_preset_bundles (
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 preset text not null,
 bundle_id text not null references public.mcp_context_bundles(id) on delete cascade,
 required_flag boolean not null default true,
 sort_order integer not null default 0,
 created_at timestamptz not null default now(),
 primary key (workspace_id,preset,bundle_id),
 constraint mcp_workspace_preset_bundles_preset_check
   check (preset in ('low','medium','high','custom1','custom2'))
);

create table if not exists public.mcp_workspace_presets (
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 preset text not null,
 project_id text references public.mcp_projects(id) on delete set null,
 updated_by_user_id text,
 updated_at timestamptz not null default now(),
 primary key (workspace_id,preset),
 constraint mcp_workspace_presets_preset_check
   check (preset in ('low','medium','high','custom1','custom2'))
);

create table if not exists public.mcp_clients (
 id text primary key,
 client_name text not null default '',
 user_id text,
 status text not null default 'active',
 metadata jsonb not null default '{}'::jsonb,
 redirect_uris jsonb not null default '[]'::jsonb,
 workspace_ids jsonb not null default '[]'::jsonb,
 permissions jsonb not null default '{}'::jsonb,
 last_seen_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.mcp_sessions (
 id text primary key default gen_random_uuid()::text,
 client_id text not null,
 user_id text,
 username text,
 status text not null default 'active',
 workspace_ids jsonb not null default '[]'::jsonb,
 workspace_id text,
 provider text not null default 'mcp',
 request_count bigint not null default 0,
 connected_at timestamptz not null default now(),
 metadata jsonb not null default '{}'::jsonb,
 last_seen_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.mcp_active_contexts (
 id text primary key default gen_random_uuid()::text,
 user_id text not null,
 client_id text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 context_key text not null,
 receipt jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.mcp_oauth_clients (
 client_id text primary key,
 client_name text not null default '',
 redirect_uris jsonb not null default '[]'::jsonb,
 scope text not null default 'orbitfs:read',
 client_uri text,
 logo_uri text,
 application_type text,
 token_endpoint_auth_method text,
 registration_access_token_hash text,
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.mcp_oauth_codes (
 code_hash text primary key,
 client_id text not null,
 user_id text not null,
 redirect_uri text not null,
 scope text not null,
 resource text not null,
 code_challenge text not null,
 code_challenge_method text not null default 'S256',
 expires_at timestamptz not null,
 consumed_at timestamptz
);

create table if not exists public.mcp_oauth_tokens (
 access_token_hash text primary key,
 refresh_token_hash text,
 client_id text not null,
 user_id text not null,
 scope text not null,
 resource text not null,
 expires_at timestamptz not null,
 refresh_expires_at timestamptz,
 revoked_at timestamptz,
 last_used_at timestamptz,
 created_at timestamptz not null default now()
);

create table if not exists public.mcp_audit_log (
 id text primary key default gen_random_uuid()::text,
 scope_id text not null default 'public',
 actor_user_id text,
 event_type text not null,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);

alter table public.mcp_sessions
 add column if not exists workspace_id text,
 add column if not exists provider text not null default 'mcp',
 add column if not exists request_count bigint not null default 0,
 add column if not exists connected_at timestamptz not null default now();

alter table public.mcp_workspace_default_items add column if not exists missing boolean not null default false;
alter table public.mcp_workspace_preset_items add column if not exists item_type text not null default 'file';
alter table public.mcp_project_preset_items add column if not exists item_type text not null default 'file';
alter table public.mcp_workspace_preset_metadata add column if not exists updated_by_user_id text;
alter table public.mcp_project_preset_metadata add column if not exists updated_by_user_id text;

do $$ declare t text; begin
 foreach t in array array[
  'mcp_projects','mcp_project_items','mcp_context_bundles','mcp_context_bundle_entries',
  'mcp_context_bundle_dependencies','mcp_project_context_bundles','mcp_workspace_startup',
  'mcp_workspace_startup_projects','mcp_workspace_default_profiles','mcp_workspace_default_profile_bundles',
  'mcp_workspace_default_items','mcp_workspace_preset_items','mcp_workspace_preset_profiles',
  'mcp_workspace_preset_profile_bundles','mcp_workspace_preset_metadata','mcp_project_preset_items',
  'mcp_project_preset_profiles','mcp_project_preset_profile_bundles','mcp_project_preset_metadata',
  'mcp_project_preset_bundles','mcp_workspace_preset_bundles','mcp_workspace_presets',
  'mcp_clients','mcp_sessions','mcp_active_contexts','mcp_oauth_clients','mcp_oauth_codes',
  'mcp_oauth_tokens','mcp_audit_log'
 ] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on table public.%I from anon, authenticated',t);
  execute format('grant select,insert,update,delete on table public.%I to service_role',t);
 end loop;
end $$;

create index if not exists idx_mcp_projects_workspace on public.mcp_projects(workspace_id);
create index if not exists idx_mcp_project_items_project on public.mcp_project_items(project_id);
create index if not exists idx_mcp_context_bundles_workspace on public.mcp_context_bundles(workspace_id);
create index if not exists idx_mcp_context_bundle_entries_bundle on public.mcp_context_bundle_entries(bundle_id);
create index if not exists idx_mcp_project_context_bundles_project on public.mcp_project_context_bundles(project_id);
create index if not exists idx_mcp_workspace_startup_projects_workspace on public.mcp_workspace_startup_projects(workspace_id);
create index if not exists idx_mcp_active_contexts_workspace on public.mcp_active_contexts(workspace_id);
create index if not exists idx_mcp_workspace_preset_bundles_workspace_preset_sort on public.mcp_workspace_preset_bundles(workspace_id,preset,sort_order);
create index if not exists idx_mcp_workspace_preset_bundles_bundle on public.mcp_workspace_preset_bundles(bundle_id);
create index if not exists idx_mcp_workspace_presets_project on public.mcp_workspace_presets(project_id);
create unique index if not exists ux_mcp_context_bundles_workspace_name on public.mcp_context_bundles(workspace_id,name);
create unique index if not exists ux_mcp_context_bundle_dependencies_pair on public.mcp_context_bundle_dependencies(bundle_id,depends_on_bundle_id);
create unique index if not exists ux_mcp_project_preset_bundles_assignment on public.mcp_project_preset_bundles(project_id,preset,bundle_id);

notify pgrst,'reload schema';
