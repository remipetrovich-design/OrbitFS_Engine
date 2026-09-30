-- Normalize the two high-growth JSON state stores while preserving their legacy runtime APIs.
-- Runtime access remains protected by RLS + private.orbitfs_server_allowed().

create table if not exists public.mcp_active_context_items (
  context_id uuid not null references public.mcp_active_contexts(id) on delete cascade,
  item_key text not null,
  position integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (context_id, item_key)
);
create index if not exists mcp_active_context_items_context_position_idx
  on public.mcp_active_context_items(context_id, position);
alter table public.mcp_active_context_items enable row level security;
drop policy if exists orbitfs_server_only on public.mcp_active_context_items;
create policy orbitfs_server_only on public.mcp_active_context_items
  for all to anon, authenticated
  using (private.orbitfs_server_allowed())
  with check (private.orbitfs_server_allowed());
grant all on table public.mcp_active_context_items to service_role;

-- Migrate any pre-normalization receipts without changing logical context contents.
insert into public.mcp_active_context_items(context_id,item_key,position,payload,updated_at)
select c.id,
  case
    when coalesce(f.payload->>'knowledgeItemId','')<>'' then 'knowledge:'||(f.payload->>'knowledgeItemId')
    when coalesce(f.payload->>'profileId','')<>'' then 'profile:'||(f.payload->>'profileId')
    when coalesce(f.payload->>'path','')<>'' then 'path:'||lower(trim(both '/' from f.payload->>'path'))
    else 'item:'||(f.ord-1)::text
  end,
  (f.ord-1)::integer,
  f.payload,
  c.updated_at
from public.mcp_active_contexts c
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(c.receipt->'files')='array' then c.receipt->'files' else '[]'::jsonb end
) with ordinality as f(payload,ord)
on conflict (context_id,item_key) do update
set position=excluded.position,payload=excluded.payload,updated_at=excluded.updated_at;
update public.mcp_active_contexts set receipt=receipt-'files' where receipt ? 'files';

create or replace function public.orbitfs_mcp_context_get(
  p_user_id uuid,p_client_id text,p_workspace_id uuid,p_context_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_id uuid; v_header jsonb; v_files jsonb;
begin
  select id,receipt into v_id,v_header
  from public.mcp_active_contexts
  where user_id=p_user_id and client_id=p_client_id
    and workspace_id=p_workspace_id and context_key=p_context_key;
  if v_id is null then return null; end if;
  select coalesce(jsonb_agg(payload order by position,item_key),'[]'::jsonb)
    into v_files
  from public.mcp_active_context_items where context_id=v_id;
  return coalesce(v_header,'{}'::jsonb)
    || jsonb_build_object('files',coalesce(v_files,'[]'::jsonb));
end;
$$;
grant execute on function public.orbitfs_mcp_context_get(uuid,text,uuid,text) to anon,authenticated,service_role;

create or replace function public.orbitfs_mcp_context_patch(
  p_user_id uuid,p_client_id text,p_workspace_id uuid,p_context_key text,
  p_header jsonb default '{}'::jsonb,
  p_upserts jsonb default '[]'::jsonb,
  p_deletes jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_id uuid; v_row jsonb; v_key text; v_position integer; v_payload jsonb;
begin
  select id into v_id from public.mcp_active_contexts
  where user_id=p_user_id and client_id=p_client_id
    and workspace_id=p_workspace_id and context_key=p_context_key;
  if v_id is null then
    insert into public.mcp_active_contexts(user_id,client_id,workspace_id,context_key,receipt,updated_at)
    values(p_user_id,p_client_id,p_workspace_id,p_context_key,coalesce(p_header,'{}'::jsonb)-'files',now())
    returning id into v_id;
  else
    update public.mcp_active_contexts
      set receipt=coalesce(p_header,'{}'::jsonb)-'files',updated_at=now()
    where id=v_id and receipt is distinct from (coalesce(p_header,'{}'::jsonb)-'files');
    if not found then update public.mcp_active_contexts set updated_at=now() where id=v_id; end if;
  end if;

  for v_row in select value from jsonb_array_elements(
    case when jsonb_typeof(p_upserts)='array' then p_upserts else '[]'::jsonb end
  ) loop
    v_key=coalesce(v_row->>'itemKey','');
    if v_key='' then continue; end if;
    v_position=coalesce((v_row->>'position')::integer,0);
    v_payload=coalesce(v_row->'payload','{}'::jsonb);
    insert into public.mcp_active_context_items(context_id,item_key,position,payload,updated_at)
    values(v_id,v_key,v_position,v_payload,now())
    on conflict(context_id,item_key) do update
      set position=excluded.position,payload=excluded.payload,updated_at=excluded.updated_at
      where public.mcp_active_context_items.position is distinct from excluded.position
         or public.mcp_active_context_items.payload is distinct from excluded.payload;
  end loop;

  delete from public.mcp_active_context_items
  where context_id=v_id and item_key in (
    select value #>> '{}' from jsonb_array_elements(
      case when jsonb_typeof(p_deletes)='array' then p_deletes else '[]'::jsonb end
    )
  );
  return jsonb_build_object('id',v_id,'updatedAt',now());
end;
$$;
grant execute on function public.orbitfs_mcp_context_patch(uuid,text,uuid,text,jsonb,jsonb,jsonb) to anon,authenticated,service_role;

create or replace function public.orbitfs_mcp_context_clear(
  p_user_id uuid,p_client_id text,p_workspace_id uuid,p_context_key text
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  delete from public.mcp_active_contexts
  where user_id=p_user_id and client_id=p_client_id
    and workspace_id=p_workspace_id and context_key=p_context_key;
  get diagnostics v_count=row_count;
  return v_count>0;
end;
$$;
grant execute on function public.orbitfs_mcp_context_clear(uuid,text,uuid,text) to anon,authenticated,service_role;

create or replace function public.orbitfs_mcp_context_ui(
  p_user_id uuid,p_client_id text,p_workspace_id uuid,p_context_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_id uuid; v_header jsonb; v_files jsonb;
begin
  select id,receipt into v_id,v_header
  from public.mcp_active_contexts
  where user_id=p_user_id and client_id=p_client_id
    and workspace_id=p_workspace_id and context_key=p_context_key;
  if v_id is null then return null; end if;
  select coalesce(
    jsonb_agg((payload-'content'-'data'-'raw'-'body'-'text'-'base64'-'blob'-'bytesData') order by position,item_key),
    '[]'::jsonb
  ) into v_files
  from public.mcp_active_context_items where context_id=v_id;
  return coalesce(v_header,'{}'::jsonb)
    || jsonb_build_object('files',coalesce(v_files,'[]'::jsonb));
end;
$$;
grant execute on function public.orbitfs_mcp_context_ui(uuid,text,uuid,text) to anon,authenticated,service_role;

create table if not exists public.orbitfs_library_meta (
  workspace_id uuid primary key,
  version integer not null default 9,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.orbitfs_library_objects (
  workspace_id uuid not null,
  bucket text not null,
  object_id text not null,
  position integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(workspace_id,bucket,object_id),
  constraint orbitfs_library_objects_bucket_check check (bucket in (
    'items','collections','groups','categories','links','usage','sections','events',
    'sourceHistory','autoLinks','entities','entityMentions','facts','factRelations','records','changeRequests'
  ))
);
create index if not exists orbitfs_library_objects_workspace_bucket_position_idx
  on public.orbitfs_library_objects(workspace_id,bucket,position);
alter table public.orbitfs_library_meta enable row level security;
alter table public.orbitfs_library_objects enable row level security;
drop policy if exists orbitfs_server_only on public.orbitfs_library_meta;
create policy orbitfs_server_only on public.orbitfs_library_meta
  for all to anon,authenticated using(private.orbitfs_server_allowed()) with check(private.orbitfs_server_allowed());
drop policy if exists orbitfs_server_only on public.orbitfs_library_objects;
create policy orbitfs_server_only on public.orbitfs_library_objects
  for all to anon,authenticated using(private.orbitfs_server_allowed()) with check(private.orbitfs_server_allowed());
grant all on table public.orbitfs_library_meta,public.orbitfs_library_objects to service_role;

-- Migrate legacy whole-state rows if any exist.
insert into public.orbitfs_library_meta(workspace_id,version,settings,created_at,updated_at)
select workspace_id,coalesce((state->>'version')::integer,9),coalesce(state->'settings','{}'::jsonb),updated_at,updated_at
from public.orbitfs_library_state
on conflict(workspace_id) do update
set version=excluded.version,settings=excluded.settings,updated_at=excluded.updated_at;

insert into public.orbitfs_library_objects(workspace_id,bucket,object_id,position,payload,updated_at)
select s.workspace_id,b.bucket,
  case when jsonb_typeof(a.payload)='object' and coalesce(a.payload->>'id','')<>''
       then a.payload->>'id' else '__pos:'||(a.ord-1)::text end,
  (a.ord-1)::integer,a.payload,s.updated_at
from public.orbitfs_library_state s
cross join lateral (values
  ('items'),('collections'),('groups'),('categories'),('links'),('usage'),('sections'),('events'),
  ('sourceHistory'),('autoLinks'),('entities'),('entityMentions'),('facts'),('factRelations'),('records'),('changeRequests')
) b(bucket)
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(s.state->b.bucket)='array' then s.state->b.bucket else '[]'::jsonb end
) with ordinality a(payload,ord)
on conflict(workspace_id,bucket,object_id) do update
set position=excluded.position,payload=excluded.payload,updated_at=excluded.updated_at;

create or replace function public.orbitfs_library_state_get(p_workspace_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_meta public.orbitfs_library_meta%rowtype; v_state jsonb; v_bucket text; v_items jsonb;
begin
  select * into v_meta from public.orbitfs_library_meta where workspace_id=p_workspace_id;
  if not found and not exists(select 1 from public.orbitfs_library_objects where workspace_id=p_workspace_id) then
    return null;
  end if;
  v_state=jsonb_build_object(
    'version',coalesce(v_meta.version,9),
    'workspaceId',p_workspace_id::text,
    'settings',coalesce(v_meta.settings,'{}'::jsonb),
    'createdAt',coalesce(v_meta.created_at,now()),
    'updatedAt',coalesce(v_meta.updated_at,now())
  );
  foreach v_bucket in array array[
    'items','collections','groups','categories','links','usage','sections','events',
    'sourceHistory','autoLinks','entities','entityMentions','facts','factRelations','records','changeRequests'
  ] loop
    select coalesce(jsonb_agg(payload order by position,object_id),'[]'::jsonb)
      into v_items
    from public.orbitfs_library_objects
    where workspace_id=p_workspace_id and bucket=v_bucket;
    v_state=v_state||jsonb_build_object(v_bucket,coalesce(v_items,'[]'::jsonb));
  end loop;
  return v_state;
end;
$$;
grant execute on function public.orbitfs_library_state_get(uuid) to anon,authenticated,service_role;

create or replace function public.orbitfs_library_state_patch(
  p_workspace_id uuid,
  p_upserts jsonb default '[]'::jsonb,
  p_deletes jsonb default '[]'::jsonb,
  p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_row jsonb; v_bucket text; v_id text; v_position integer; v_payload jsonb; v_updated timestamptz:=now();
begin
  insert into public.orbitfs_library_meta(workspace_id,version,settings,created_at,updated_at)
  values(p_workspace_id,coalesce((p_meta->>'version')::integer,9),coalesce(p_meta->'settings','{}'::jsonb),v_updated,v_updated)
  on conflict(workspace_id) do update
  set version=coalesce((p_meta->>'version')::integer,public.orbitfs_library_meta.version),
      settings=coalesce(p_meta->'settings',public.orbitfs_library_meta.settings),
      updated_at=v_updated;

  for v_row in select value from jsonb_array_elements(
    case when jsonb_typeof(p_upserts)='array' then p_upserts else '[]'::jsonb end
  ) loop
    v_bucket=coalesce(v_row->>'bucket','');
    v_id=coalesce(v_row->>'objectId','');
    if v_bucket='' or v_id='' then continue; end if;
    if v_bucket not in (
      'items','collections','groups','categories','links','usage','sections','events',
      'sourceHistory','autoLinks','entities','entityMentions','facts','factRelations','records','changeRequests'
    ) then raise exception 'Invalid Library bucket: %',v_bucket; end if;
    v_position=coalesce((v_row->>'position')::integer,0);
    v_payload=coalesce(v_row->'payload','null'::jsonb);
    insert into public.orbitfs_library_objects(workspace_id,bucket,object_id,position,payload,updated_at)
    values(p_workspace_id,v_bucket,v_id,v_position,v_payload,v_updated)
    on conflict(workspace_id,bucket,object_id) do update
      set position=excluded.position,payload=excluded.payload,updated_at=excluded.updated_at
      where public.orbitfs_library_objects.position is distinct from excluded.position
         or public.orbitfs_library_objects.payload is distinct from excluded.payload;
  end loop;

  for v_row in select value from jsonb_array_elements(
    case when jsonb_typeof(p_deletes)='array' then p_deletes else '[]'::jsonb end
  ) loop
    delete from public.orbitfs_library_objects
    where workspace_id=p_workspace_id
      and bucket=v_row->>'bucket'
      and object_id=v_row->>'objectId';
  end loop;
  return jsonb_build_object('updatedAt',v_updated);
end;
$$;
grant execute on function public.orbitfs_library_state_patch(uuid,jsonb,jsonb,jsonb) to anon,authenticated,service_role;
