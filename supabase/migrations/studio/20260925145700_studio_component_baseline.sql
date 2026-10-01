-- OrbitFS Studio component baseline.
-- Historical Base releases created these tables. This migration transfers
-- ongoing schema ownership to the Studio Engine component without deleting data.

create extension if not exists pgcrypto;

create table if not exists public.studio_documents (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 kind text not null default 'document',
 subtype text not null default 'general',
 title text not null,
 status text not null default 'draft',
 content_format text not null default 'md',
 content_text text not null default '',
 summary text,
 entry_date text,
 current_revision integer not null default 1,
 owner_user_id text,
 created_by_user_id text,
 created_by text,
 visibility text not null default 'private',
 profile_ids jsonb not null default '[]'::jsonb,
 save_location text not null default '',
 metadata_json jsonb not null default '{}'::jsonb,
 finalized_at timestamptz,
 archived_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.studio_revisions (
 id text primary key default gen_random_uuid()::text,
 document_id text not null references public.studio_documents(id) on delete cascade,
 revision_no integer not null,
 content_text text not null default '',
 content_hash text not null default '',
 change_note text not null default '',
 created_by text,
 created_at timestamptz not null default now(),
 unique(document_id,revision_no)
);

create table if not exists public.studio_shares (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 document_id text not null references public.studio_documents(id) on delete cascade,
 user_id text not null,
 permission text not null default 'read',
 shared_by_user_id text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(document_id,user_id)
);

create table if not exists public.studio_analysis_runs (
 id text primary key default gen_random_uuid()::text,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 scope_type text not null default 'workspace',
 scope_json jsonb not null default '{}'::jsonb,
 status text not null default 'running',
 phase text not null default 'inventory',
 progress integer not null default 0,
 created_by_user_id text,
 created_by text,
 started_at timestamptz,
 completed_at timestamptz,
 source_count integer not null default 0,
 record_count integer not null default 0,
 finding_count integer not null default 0,
 summary_json jsonb not null default '{}'::jsonb,
 provider_json jsonb not null default '{}'::jsonb,
 error_text text,
 updated_at timestamptz not null default now(),
 created_at timestamptz not null default now()
);

create table if not exists public.studio_analysis_records (
 id text primary key default gen_random_uuid()::text,
 run_id text not null references public.studio_analysis_runs(id) on delete cascade,
 source_id text,
 source_type text,
 title text,
 content_text text,
 entry_date text,
 record_type text,
 profile_id text,
 metadata_json jsonb not null default '{}'::jsonb,
 record_key text,
 body text,
 date_start text,
 content_hash text,
 created_at timestamptz not null default now()
);

create table if not exists public.studio_analysis_findings (
 id text primary key default gen_random_uuid()::text,
 run_id text not null references public.studio_analysis_runs(id) on delete cascade,
 record_id text references public.studio_analysis_records(id) on delete cascade,
 finding_type text not null default 'review',
 target_system text,
 target_item_id text,
 target_section_id text,
 confidence numeric not null default 0,
 score_json jsonb not null default '{}'::jsonb,
 explanation text not null default '',
 target_json jsonb,
 proposal_json jsonb,
 status text not null default 'candidate',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.studio_settings (
 workspace_id text primary key,
 settings_json jsonb not null default '{}'::jsonb,
 updated_by text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.studio_analysis_sources (
 id text primary key default gen_random_uuid()::text,
 run_id text not null references public.studio_analysis_runs(id) on delete cascade,
 workspace_id text not null references public.orbitfs_workspaces(id) on delete cascade,
 source_key text not null,
 source_type text not null,
 provider text not null,
 source_ref text,
 item_id text,
 profile_id text,
 title text not null default '',
 source_hash text not null default '',
 source_updated_at timestamptz,
 metadata_json jsonb not null default '{}'::jsonb,
 status text not null default 'ready',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(run_id,source_key)
);

alter table public.studio_documents add column if not exists finalized_at timestamptz, add column if not exists archived_at timestamptz;
alter table public.studio_shares add column if not exists shared_by_user_id text;
alter table public.studio_analysis_records
 add column if not exists record_key text,
 add column if not exists body text,
 add column if not exists date_start text,
 add column if not exists content_hash text;

do $$ declare t text; begin
 foreach t in array array[
  'studio_documents','studio_revisions','studio_shares','studio_analysis_runs',
  'studio_analysis_records','studio_analysis_findings','studio_settings','studio_analysis_sources'
 ] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on table public.%I from anon, authenticated',t);
  execute format('grant select,insert,update,delete on table public.%I to service_role',t);
 end loop;
end $$;

create index if not exists idx_studio_documents_workspace on public.studio_documents(workspace_id);
create index if not exists idx_studio_revisions_document on public.studio_revisions(document_id);
create index if not exists idx_studio_shares_workspace_user on public.studio_shares(workspace_id,user_id);
create index if not exists idx_studio_analysis_runs_workspace on public.studio_analysis_runs(workspace_id);
create index if not exists idx_studio_analysis_findings_run on public.studio_analysis_findings(run_id);
create index if not exists idx_studio_analysis_sources_run on public.studio_analysis_sources(run_id);
create index if not exists idx_studio_analysis_sources_workspace on public.studio_analysis_sources(workspace_id);
create unique index if not exists ux_studio_analysis_records_run_record_key on public.studio_analysis_records(run_id,record_key) where record_key is not null;

notify pgrst,'reload schema';
