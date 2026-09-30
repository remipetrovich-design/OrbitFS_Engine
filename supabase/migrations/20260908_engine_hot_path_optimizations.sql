-- OrbitFS Engine runtime hot-path/security optimizations.
-- Mirrors the live orbitfs-phase1 changes applied 2026-09-08.

-- Studio analysis/link tables must use the same server-only access model as the
-- rest of the Engine runtime.
alter table if exists public.studio_analysis_runs enable row level security;
alter table if exists public.studio_analysis_sources enable row level security;
alter table if exists public.studio_analysis_records enable row level security;
alter table if exists public.studio_analysis_findings enable row level security;
alter table if exists public.studio_analysis_state enable row level security;
alter table if exists public.studio_links enable row level security;

-- Keep the shared server-secret guard out of the exposed public RPC schema.
create or replace function private.orbitfs_server_allowed()
returns boolean
language sql
stable
security definer
set search_path to 'public','private','extensions'
as $$
  select coalesce(
    ((current_setting('request.headers', true))::jsonb ->> 'x-orbitfs-secret') =
      (select value from private.orbitfs_runtime_config where key='server_secret')
    or encode(
      extensions.digest(
        convert_to(coalesce((current_setting('request.headers', true))::jsonb ->> 'x-orbitfs-secret',''),'UTF8'),
        'sha256'
      ),
      'hex'
    ) = (select value from private.orbitfs_runtime_config where key='mcp_server_secret_sha256'),
    false
  );
$$;
grant usage on schema private to public;
grant execute on function private.orbitfs_server_allowed() to public;

-- Repoint existing public-table server-only policies without changing their
-- roles or command scope.
do $$
declare r record;
begin
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname='public'
      and cmd='ALL'
      and (coalesce(qual,'')='orbitfs_server_allowed()' or coalesce(with_check,'')='orbitfs_server_allowed()')
  loop
    execute format(
      'alter policy %I on public.%I using (private.orbitfs_server_allowed()) with check (private.orbitfs_server_allowed())',
      r.policyname,
      r.tablename
    );
  end loop;
end $$;

-- Ensure the six Studio tables have a server-only policy even on installs that
-- predate these tables being secured.
do $$
declare t text;
begin
  foreach t in array array[
    'studio_analysis_runs','studio_analysis_sources','studio_analysis_records',
    'studio_analysis_findings','studio_analysis_state','studio_links'
  ]
  loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists orbitfs_server_only on public.%I',t);
      execute format(
        'create policy orbitfs_server_only on public.%I for all to anon, authenticated using (private.orbitfs_server_allowed()) with check (private.orbitfs_server_allowed())',
        t
      );
    end if;
  end loop;
end $$;

-- Storage policies use the same private guard while remaining restricted to the
-- OrbitFS bucket.
do $$
begin
  if exists(select 1 from pg_policies where schemaname='storage' and tablename='buckets' and policyname='orbitfs_files_bucket_server_select') then
    alter policy orbitfs_files_bucket_server_select on storage.buckets
      using ((id='orbitfs-files'::text) and private.orbitfs_server_allowed());
  end if;
  if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='orbitfs_files_server_select') then
    alter policy orbitfs_files_server_select on storage.objects
      using ((bucket_id='orbitfs-files'::text) and private.orbitfs_server_allowed());
  end if;
  if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='orbitfs_files_server_insert') then
    alter policy orbitfs_files_server_insert on storage.objects
      with check ((bucket_id='orbitfs-files'::text) and private.orbitfs_server_allowed());
  end if;
  if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='orbitfs_files_server_update') then
    alter policy orbitfs_files_server_update on storage.objects
      using ((bucket_id='orbitfs-files'::text) and private.orbitfs_server_allowed())
      with check ((bucket_id='orbitfs-files'::text) and private.orbitfs_server_allowed());
  end if;
  if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='orbitfs_files_server_delete') then
    alter policy orbitfs_files_server_delete on storage.objects
      using ((bucket_id='orbitfs-files'::text) and private.orbitfs_server_allowed());
  end if;
end $$;

-- Foreign-key and hot lookup indexes reported by Supabase's advisor.
create index if not exists mcp_context_bundle_dependencies_depends_on_idx on public.mcp_context_bundle_dependencies(depends_on_bundle_id);
create index if not exists mcp_oauth_codes_client_id_idx on public.mcp_oauth_codes(client_id);
create index if not exists mcp_project_context_bundles_bundle_id_idx on public.mcp_project_context_bundles(bundle_id);
create index if not exists mcp_project_preset_bundles_bundle_id_idx on public.mcp_project_preset_bundles(bundle_id);
create index if not exists mcp_sessions_client_id_idx on public.mcp_sessions(client_id);
create index if not exists mcp_workspace_preset_bundles_bundle_id_idx on public.mcp_workspace_preset_bundles(bundle_id);
create index if not exists orbitfs_audit_log_actor_user_id_idx on public.orbitfs_audit_log(actor_user_id);
create index if not exists orbitfs_files_created_by_idx on public.orbitfs_files(created_by);
create index if not exists orbitfs_files_parent_id_idx on public.orbitfs_files(parent_id);
create index if not exists orbitfs_group_members_user_id_idx on public.orbitfs_group_members(user_id);
create index if not exists orbitfs_library_approval_queue_decided_by_idx on public.orbitfs_library_approval_queue(decided_by);
create index if not exists orbitfs_library_approval_queue_item_id_idx on public.orbitfs_library_approval_queue(item_id);
create index if not exists orbitfs_library_approval_queue_requested_by_idx on public.orbitfs_library_approval_queue(requested_by);
create index if not exists orbitfs_library_items_created_by_idx on public.orbitfs_library_items(created_by);
create index if not exists orbitfs_library_revisions_created_by_idx on public.orbitfs_library_revisions(created_by);
create index if not exists orbitfs_profiles_created_by_idx on public.orbitfs_profiles(created_by);
create index if not exists orbitfs_registration_requests_created_user_id_idx on public.orbitfs_registration_requests(created_user_id);
create index if not exists orbitfs_registration_requests_decided_by_idx on public.orbitfs_registration_requests(decided_by);
create index if not exists orbitfs_sessions_user_id_idx on public.orbitfs_sessions(user_id);
create index if not exists orbitfs_shares_created_by_idx on public.orbitfs_shares(created_by);
create index if not exists orbitfs_shares_file_id_idx on public.orbitfs_shares(file_id);
create index if not exists orbitfs_shares_workspace_id_idx on public.orbitfs_shares(workspace_id);
create index if not exists orbitfs_workspace_messages_created_by_idx on public.orbitfs_workspace_messages(created_by);
create index if not exists orbitfs_workspace_requests_decided_by_id_idx on public.orbitfs_workspace_requests(decided_by_id);
create index if not exists orbitfs_workspace_requests_requested_by_id_idx on public.orbitfs_workspace_requests(requested_by_id);
create index if not exists orbitfs_workspace_requests_target_user_id_idx on public.orbitfs_workspace_requests(target_user_id);
create index if not exists orbitfs_workspaces_created_by_idx on public.orbitfs_workspaces(created_by);
create index if not exists orbitfs_workspaces_owner_id_idx on public.orbitfs_workspaces(owner_id);
create index if not exists studio_analysis_findings_record_id_idx on public.studio_analysis_findings(record_id);
create index if not exists studio_analysis_records_source_id_idx on public.studio_analysis_records(source_id);
create index if not exists studio_events_document_id_idx on public.studio_events(document_id);
create index if not exists studio_links_document_id_idx on public.studio_links(document_id);
create index if not exists studio_sessions_document_id_idx on public.studio_sessions(document_id);
create index if not exists orbitfs_files_workspace_parent_active_idx on public.orbitfs_files(workspace_id,parent_path,kind,name) where deleted_at is null;

-- Only one live MCP session is kept for a user/client/context identity.
create unique index if not exists mcp_sessions_active_context_key_uidx
on public.mcp_sessions(user_id,coalesce(client_id,'chatgpt'),((metadata->>'contextKey')))
where status='active' and coalesce(metadata->>'contextKey','')<>'';
create index if not exists mcp_sessions_context_lookup_idx
on public.mcp_sessions(user_id,status,last_seen_at desc)
where status='active';

-- Throttled add-on activity touch: no read/merge/whole-runtime write in Node.
create or replace function public.orbitfs_touch_addon_request(p_addon_id text,p_min_interval_seconds integer default 30)
returns boolean
language plpgsql
set search_path to 'public'
as $$
declare changed integer;
begin
  if not private.orbitfs_server_allowed() then
    raise exception 'OrbitFS server authorization required' using errcode='42501';
  end if;
  update public.orbitfs_addons
     set runtime=coalesce(runtime,'{}'::jsonb)||jsonb_build_object('lastRequestAt',now()),
         updated_at=now()
   where id=p_addon_id
     and coalesce((runtime->>'lastRequestAt')::timestamptz,'epoch'::timestamptz)
       <= now()-make_interval(secs=>greatest(1,p_min_interval_seconds));
  get diagnostics changed=row_count;
  return changed>0;
end;
$$;

-- Atomic MCP session touch. This replaces select + update + optional client
-- lookup + insert in the Engine runtime.
create or replace function public.orbitfs_touch_mcp_session(
  p_user_id text,p_client_id text,p_username text,p_workspace_id text,p_context_key text,p_conversation_id text
) returns jsonb
language plpgsql
set search_path=public,extensions
as $$
declare v_id uuid; v_workspace text; v_client_id text; v_now timestamptz:=now();
begin
  if not private.orbitfs_server_allowed() then raise exception 'OrbitFS server authorization required' using errcode='42501'; end if;
  if coalesce(trim(p_user_id),'')='' or coalesce(trim(p_context_key),'')='' then raise exception 'MCP session identity is required' using errcode='22023'; end if;
  v_client_id:=case when coalesce(p_client_id,'chatgpt')='chatgpt' then null else p_client_id end;
  if v_client_id is not null and not exists(select 1 from public.mcp_clients where id=v_client_id) then v_client_id:=null; end if;
  select s.id,s.workspace_id into v_id,v_workspace from public.mcp_sessions s
   where s.user_id=p_user_id and s.status='active'
     and coalesce(s.client_id,'chatgpt')=coalesce(v_client_id,'chatgpt')
     and s.metadata->>'contextKey'=p_context_key
   order by s.last_seen_at desc limit 1 for update;
  if v_id is not null then
    update public.mcp_sessions
       set request_count=coalesce(request_count,0)+1,last_seen_at=v_now,username=p_username,
           metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('contextKey',p_context_key,'conversationId',p_conversation_id)
     where id=v_id;
    return jsonb_build_object('id',v_id,'workspaceId',v_workspace,'created',false);
  end if;
  begin
    insert into public.mcp_sessions(client_id,user_id,username,workspace_id,provider,status,request_count,metadata,last_seen_at)
    values(v_client_id,p_user_id,p_username,p_workspace_id,'chatgpt','active',1,
      jsonb_build_object('contextKey',p_context_key,'conversationId',p_conversation_id),v_now)
    returning id,workspace_id into v_id,v_workspace;
  exception when unique_violation then
    select s.id,s.workspace_id into v_id,v_workspace from public.mcp_sessions s
     where s.user_id=p_user_id and s.status='active'
       and coalesce(s.client_id,'chatgpt')=coalesce(v_client_id,'chatgpt')
       and s.metadata->>'contextKey'=p_context_key
     order by s.last_seen_at desc limit 1;
    update public.mcp_sessions
       set request_count=coalesce(request_count,0)+1,last_seen_at=v_now,username=p_username,
           metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('contextKey',p_context_key,'conversationId',p_conversation_id)
     where id=v_id;
  end;
  return jsonb_build_object('id',v_id,'workspaceId',v_workspace,'created',true);
end;
$$;

create or replace function public.orbitfs_set_mcp_session_workspace(p_session_id uuid,p_workspace_id text)
returns boolean
language plpgsql
set search_path=public
as $$
begin
  if not private.orbitfs_server_allowed() then raise exception 'OrbitFS server authorization required' using errcode='42501'; end if;
  update public.mcp_sessions set workspace_id=p_workspace_id
   where id=p_session_id and workspace_id is distinct from p_workspace_id;
  return found;
end;
$$;

-- UI-only context reads remove multi-megabyte payload fields inside Postgres,
-- before PostgREST/Node ever has to carry them.
create or replace function public.orbitfs_mcp_context_ui(p_user_id uuid,p_client_id text,p_workspace_id uuid,p_context_key text)
returns jsonb
language plpgsql
stable
set search_path=public
as $$
declare v_receipt jsonb; v_files jsonb;
begin
  if not private.orbitfs_server_allowed() then raise exception 'OrbitFS server authorization required' using errcode='42501'; end if;
  select receipt into v_receipt from public.mcp_active_contexts
   where user_id=p_user_id and client_id=p_client_id and workspace_id=p_workspace_id and context_key=p_context_key limit 1;
  if v_receipt is null then return null; end if;
  select coalesce(jsonb_agg(value-'content'-'data'-'raw'-'body'-'text'-'base64'-'blob'-'bytesData'),'[]'::jsonb)
    into v_files from jsonb_array_elements(coalesce(v_receipt->'files','[]'::jsonb));
  return (v_receipt-'files')||jsonb_build_object('files',v_files);
end;
$$;

-- Monitoring metrics, activity and sessions are aggregated/enriched in one DB
-- request instead of many independent REST reads.
create or replace function public.orbitfs_mcp_monitoring_snapshot(p_activity_limit integer default 100,p_session_limit integer default 50)
returns jsonb
language plpgsql
stable
set search_path=public
as $$
declare v_metrics jsonb; v_activity jsonb; v_sessions jsonb;
begin
  if not private.orbitfs_server_allowed() then raise exception 'OrbitFS server authorization required' using errcode='42501'; end if;
  select jsonb_build_object(
    'clients',(select count(*) from public.mcp_clients),
    'activeClients',(select count(*) from public.mcp_clients where status='active'),
    'activeSessions',(select count(*) from public.mcp_sessions where status='active'),
    'totalRequests',(select coalesce(sum(request_count),0) from public.mcp_sessions),
    'oauthActive',(select count(*) from public.mcp_oauth_tokens where revoked_at is null and expires_at>now()),
    'auditEvents24h',(select count(*) from public.mcp_audit_log where created_at>=now()-interval '24 hours'),
    'lastClientSeenAt',(select max(last_seen_at) from public.mcp_clients),
    'lastSessionSeenAt',(select max(last_seen_at) from public.mcp_sessions)
  ) into v_metrics;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb) into v_activity from (
    select a.id,a.scope_id,a.actor_user_id,a.event_type,a.details,a.created_at,
      coalesce(u.display_name,u.username,a.actor_user_id,'OrbitFS user') as user_name,
      coalesce(c.client_name,a.details->>'clientId','ChatGPT') as client_name,
      coalesce(w.name,case when a.scope_id='global' then 'Global' else a.scope_id end,'Global') as workspace_name
    from public.mcp_audit_log a
    left join public.orbitfs_users u on u.id::text=a.actor_user_id
    left join public.mcp_clients c on c.id=a.details->>'clientId'
    left join public.orbitfs_workspaces w on w.id::text=a.scope_id
    order by a.created_at desc limit greatest(1,least(coalesce(p_activity_limit,100),250))
  ) q;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.last_seen_at desc),'[]'::jsonb) into v_sessions from (
    select s.id,s.client_id,s.user_id,s.username,s.workspace_id,s.provider,s.status,s.request_count,s.connected_at,s.last_seen_at,s.metadata,
      coalesce(s.username,u.display_name,u.username,s.user_id,'OrbitFS user') as user_name,
      coalesce(c.client_name,s.client_id,'ChatGPT') as client_name,
      coalesce(w.name,s.workspace_id,'Not selected') as workspace_name
    from public.mcp_sessions s
    left join public.orbitfs_users u on u.id::text=s.user_id
    left join public.mcp_clients c on c.id=s.client_id
    left join public.orbitfs_workspaces w on w.id::text=s.workspace_id
    order by s.last_seen_at desc limit greatest(1,least(coalesce(p_session_limit,50),100))
  ) q;
  return jsonb_build_object('metrics',v_metrics,'activity',v_activity,'sessions',v_sessions);
end;
$$;

grant execute on function public.orbitfs_touch_addon_request(text,integer) to anon,authenticated;
grant execute on function public.orbitfs_touch_mcp_session(text,text,text,text,text,text) to anon,authenticated;
grant execute on function public.orbitfs_set_mcp_session_workspace(uuid,text) to anon,authenticated;
grant execute on function public.orbitfs_mcp_context_ui(uuid,text,uuid,text) to anon,authenticated;
grant execute on function public.orbitfs_mcp_monitoring_snapshot(integer,integer) to anon,authenticated;

-- Once policies/RPCs no longer depend on the public wrapper it should not be
-- callable through PostgREST at all.
drop function if exists public.orbitfs_server_allowed();
