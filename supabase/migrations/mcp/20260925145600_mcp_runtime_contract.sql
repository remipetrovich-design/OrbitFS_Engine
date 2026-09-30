-- OrbitFS Update migration: current MCP runtime database contract.
-- Targets the rebuilt Base schema (text IDs + private.orbitfs_server_secret_valid).
-- This supersedes, but does not modify or replay, the legacy 2026-09-08 flat SQL.

alter table public.mcp_sessions
  add column if not exists workspace_id text,
  add column if not exists provider text not null default 'mcp',
  add column if not exists request_count bigint not null default 0,
  add column if not exists connected_at timestamptz not null default now();

update public.mcp_sessions
set provider = coalesce(nullif(provider,''),'mcp'),
    request_count = coalesce(request_count,0),
    connected_at = coalesce(connected_at,created_at,now())
where provider is null
   or provider = ''
   or request_count is null
   or connected_at is null;

create index if not exists idx_mcp_sessions_user_status_seen
  on public.mcp_sessions(user_id,status,last_seen_at desc);
create index if not exists idx_mcp_sessions_workspace_status
  on public.mcp_sessions(workspace_id,status);
create index if not exists idx_mcp_sessions_context_key
  on public.mcp_sessions(user_id,client_id,((metadata->>'contextKey')))
  where status='active' and coalesce(metadata->>'contextKey','')<>'';

create or replace function public.orbitfs_touch_mcp_session(
  p_user_id text,
  p_client_id text,
  p_username text,
  p_workspace_id text,
  p_context_key text,
  p_conversation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_id text;
  v_workspace text;
  v_client text := coalesce(nullif(btrim(p_client_id),''),'chatgpt');
  v_now timestamptz := now();
begin
  if not private.orbitfs_server_secret_valid() then
    raise exception 'OrbitFS server authorization required' using errcode='42501';
  end if;
  if coalesce(btrim(p_user_id),'')='' or coalesce(btrim(p_context_key),'')='' then
    raise exception 'MCP session identity is required' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'orbitfs_mcp_session:' || p_user_id || ':' || v_client || ':' || p_context_key,
    0
  ));

  select s.id,s.workspace_id
    into v_id,v_workspace
  from public.mcp_sessions s
  where s.user_id=p_user_id
    and s.client_id=v_client
    and s.status='active'
    and coalesce(s.metadata->>'contextKey','')=p_context_key
  order by s.last_seen_at desc nulls last,s.created_at desc
  limit 1
  for update;

  if v_id is null then
    insert into public.mcp_sessions(
      client_id,user_id,username,status,workspace_id,provider,request_count,
      metadata,last_seen_at,connected_at,created_at,updated_at
    )
    values(
      v_client,p_user_id,p_username,'active',p_workspace_id,'mcp',1,
      jsonb_build_object('contextKey',p_context_key,'conversationId',p_conversation_id),
      v_now,v_now,v_now,v_now
    )
    returning id,workspace_id into v_id,v_workspace;
  else
    update public.mcp_sessions
       set username=p_username,
           workspace_id=coalesce(p_workspace_id,workspace_id),
           provider='mcp',
           request_count=coalesce(request_count,0)+1,
           metadata=coalesce(metadata,'{}'::jsonb)
             || jsonb_build_object('contextKey',p_context_key,'conversationId',p_conversation_id),
           last_seen_at=v_now,
           updated_at=v_now
     where id=v_id
     returning workspace_id into v_workspace;
  end if;

  return jsonb_build_object('id',v_id,'workspaceId',v_workspace);
end;
$$;

create or replace function public.orbitfs_set_mcp_session_workspace(
  p_session_id text,
  p_workspace_id text
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

  update public.mcp_sessions
     set workspace_id=p_workspace_id,updated_at=now()
   where id=p_session_id
     and workspace_id is distinct from p_workspace_id;
  get diagnostics changed=row_count;
  return changed > 0;
end;
$$;

create or replace function public.orbitfs_mcp_context_ui(
  p_user_id text,
  p_client_id text,
  p_workspace_id text,
  p_context_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_receipt jsonb;
  v_files jsonb;
begin
  if not private.orbitfs_server_secret_valid() then
    raise exception 'OrbitFS server authorization required' using errcode='42501';
  end if;

  select receipt into v_receipt
  from public.mcp_active_contexts
  where user_id=p_user_id
    and client_id=p_client_id
    and workspace_id=p_workspace_id
    and context_key=p_context_key
  order by updated_at desc
  limit 1;

  if v_receipt is null then return null; end if;

  select coalesce(
    jsonb_agg(
      (item - 'content' - 'data' - 'raw' - 'body' - 'text' - 'base64' - 'blob' - 'bytesData')
      order by ordinality
    ),
    '[]'::jsonb
  )
  into v_files
  from jsonb_array_elements(coalesce(v_receipt->'files','[]'::jsonb))
       with ordinality as f(item,ordinality);

  return (v_receipt-'files') || jsonb_build_object('files',coalesce(v_files,'[]'::jsonb));
end;
$$;

create or replace function public.orbitfs_mcp_monitoring_snapshot(
  p_activity_limit integer default 100,
  p_session_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_metrics jsonb;
  v_activity jsonb;
  v_sessions jsonb;
begin
  if not private.orbitfs_server_secret_valid() then
    raise exception 'OrbitFS server authorization required' using errcode='42501';
  end if;

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

  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb)
  into v_activity
  from (
    select a.id,a.scope_id,a.actor_user_id,a.event_type,a.details,a.created_at,
      coalesce(u.display_name,u.username,a.actor_user_id,'OrbitFS user') as user_name,
      coalesce(c.client_name,a.details->>'clientId','ChatGPT') as client_name,
      coalesce(w.name,case when a.scope_id='global' then 'Global' else a.scope_id end,'Global') as workspace_name
    from public.mcp_audit_log a
    left join public.orbitfs_users u on u.id=a.actor_user_id
    left join public.mcp_clients c on c.id=a.details->>'clientId'
    left join public.orbitfs_workspaces w on w.id=a.scope_id
    order by a.created_at desc
    limit greatest(1,least(coalesce(p_activity_limit,100),250))
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.last_seen_at desc nulls last),'[]'::jsonb)
  into v_sessions
  from (
    select s.id,s.client_id,s.user_id,s.username,s.workspace_id,s.provider,s.status,
      s.request_count,s.connected_at,s.last_seen_at,s.metadata,
      coalesce(u.display_name,u.username,s.username,s.user_id,'OrbitFS user') as user_name,
      coalesce(c.client_name,s.client_id,'ChatGPT') as client_name,
      coalesce(w.name,s.workspace_id,'Not selected') as workspace_name
    from public.mcp_sessions s
    left join public.orbitfs_users u on u.id=s.user_id
    left join public.mcp_clients c on c.id=s.client_id
    left join public.orbitfs_workspaces w on w.id=s.workspace_id
    order by s.last_seen_at desc nulls last
    limit greatest(1,least(coalesce(p_session_limit,50),100))
  ) q;

  return jsonb_build_object('metrics',v_metrics,'activity',v_activity,'sessions',v_sessions);
end;
$$;

create or replace function public.orbitfs_mcp_search_files(
  p_workspace_id text,
  p_query text,
  p_base_path text default '',
  p_include_content boolean default false,
  p_limit integer default 50
)
returns table(
  id text,
  name text,
  path text,
  kind text,
  mime_type text,
  size_bytes bigint,
  updated_at timestamptz,
  content_text text,
  score numeric,
  excerpt text
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if not private.orbitfs_server_secret_valid() then
    raise exception 'OrbitFS server authorization required' using errcode='42501';
  end if;

  return query
  select f.id,f.name,f.path,f.kind,f.mime_type,f.size_bytes,f.updated_at,f.content_text,
    (
      case when lower(f.name)=lower(p_query) then 100
           when f.name ilike '%'||p_query||'%' then 60 else 0 end
      + case when f.path ilike '%'||p_query||'%' then 30 else 0 end
      + case when p_include_content and f.content_text ilike '%'||p_query||'%' then 10 else 0 end
    )::numeric as score,
    case when p_include_content then left(coalesce(f.content_text,''),420) else '' end as excerpt
  from public.orbitfs_files f
  where f.workspace_id=p_workspace_id
    and f.deleted_at is null
    and (coalesce(p_base_path,'')='' or f.path like trim(both '/' from p_base_path)||'/%')
    and (
      f.name ilike '%'||p_query||'%'
      or f.path ilike '%'||p_query||'%'
      or (p_include_content and f.content_text ilike '%'||p_query||'%')
    )
  order by score desc,f.path
  limit greatest(1,least(coalesce(p_limit,50),250));
end;
$$;

create or replace function public.orbitfs_mcp_folder_files(
  p_workspace_id text,
  p_base_path text default '',
  p_recursive boolean default true,
  p_max_files integer default 100,
  p_max_depth integer default 10
)
returns table(path text,kind text)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_base text := trim(both '/' from coalesce(p_base_path,''));
begin
  if not private.orbitfs_server_secret_valid() then
    raise exception 'OrbitFS server authorization required' using errcode='42501';
  end if;

  return query
  with candidates as (
    select f.path,f.kind,
      case
        when v_base='' then f.path
        else substring(f.path from char_length(v_base)+2)
      end as relative_path
    from public.orbitfs_files f
    where f.workspace_id=p_workspace_id
      and f.kind='file'
      and f.deleted_at is null
      and (v_base='' or f.path like v_base||'/%')
      and lower(f.path) not like '_trash/%'
  )
  select c.path,c.kind
  from candidates c
  where (
    p_recursive
    and (char_length(c.relative_path)-char_length(replace(c.relative_path,'/','')))
      <= greatest(0,coalesce(p_max_depth,10))
  ) or (
    not p_recursive
    and (char_length(c.relative_path)-char_length(replace(c.relative_path,'/','')))=0
  )
  order by c.path
  limit greatest(1,least(coalesce(p_max_files,100),1000));
end;
$$;

revoke all on function public.orbitfs_touch_mcp_session(text,text,text,text,text,text) from public;
revoke all on function public.orbitfs_set_mcp_session_workspace(text,text) from public;
revoke all on function public.orbitfs_mcp_context_ui(text,text,text,text) from public;
revoke all on function public.orbitfs_mcp_monitoring_snapshot(integer,integer) from public;
revoke all on function public.orbitfs_mcp_search_files(text,text,text,boolean,integer) from public;
revoke all on function public.orbitfs_mcp_folder_files(text,text,boolean,integer,integer) from public;

grant execute on function public.orbitfs_touch_mcp_session(text,text,text,text,text,text) to anon, authenticated, service_role;
grant execute on function public.orbitfs_set_mcp_session_workspace(text,text) to anon, authenticated, service_role;
grant execute on function public.orbitfs_mcp_context_ui(text,text,text,text) to anon, authenticated, service_role;
grant execute on function public.orbitfs_mcp_monitoring_snapshot(integer,integer) to anon, authenticated, service_role;
grant execute on function public.orbitfs_mcp_search_files(text,text,text,boolean,integer) to anon, authenticated, service_role;
grant execute on function public.orbitfs_mcp_folder_files(text,text,boolean,integer,integer) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
