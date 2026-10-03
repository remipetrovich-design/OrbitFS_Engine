-- One-time Panel -> Shared Engine browser session handoff.
-- Base creates a short-lived ticket using service_role. Engine consumes it
-- through its restricted runtime database credential and creates a host-local
-- session cookie. Raw tickets are never stored.

create table if not exists public.orbitfs_engine_session_handoffs (
  ticket_hash text primary key,
  installation_id text not null,
  user_id text not null references public.orbitfs_users(id) on delete cascade,
  engine_id text not null check (engine_id in ('mcp','apex','studio')),
  redirect_path text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.orbitfs_engine_session_handoffs enable row level security;
revoke all on table public.orbitfs_engine_session_handoffs from anon, authenticated;
grant select,insert,update,delete on table public.orbitfs_engine_session_handoffs to service_role;

create index if not exists idx_orbitfs_engine_session_handoffs_expires
  on public.orbitfs_engine_session_handoffs(expires_at);

create or replace function public.orbitfs_create_engine_session_handoff(
  p_ticket_hash text,
  p_installation_id text,
  p_user_id text,
  p_engine_id text,
  p_redirect_path text,
  p_ttl_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  role_claim text := coalesce(current_setting('request.jwt.claim.role', true),'');
  ttl integer := greatest(15,least(coalesce(p_ttl_seconds,60),120));
begin
  if role_claim <> 'service_role' then
    raise exception 'OrbitFS service authorization required' using errcode='42501';
  end if;
  if p_ticket_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid handoff ticket hash';
  end if;
  if p_engine_id not in ('mcp','apex','studio') then
    raise exception 'Invalid Engine component';
  end if;
  if p_redirect_path !~ ('^/engines/' || p_engine_id || '(/|$)') then
    raise exception 'Invalid Engine redirect path';
  end if;
  if length(p_redirect_path) > 512 or position('?' in p_redirect_path) > 0 or position('#' in p_redirect_path) > 0 then
    raise exception 'Invalid Engine redirect path';
  end if;

  delete from public.orbitfs_engine_session_handoffs
   where expires_at <= now() - interval '5 minutes'
      or consumed_at is not null and consumed_at <= now() - interval '5 minutes';

  insert into public.orbitfs_engine_session_handoffs(
    ticket_hash,installation_id,user_id,engine_id,redirect_path,expires_at
  ) values (
    lower(p_ticket_hash),p_installation_id,p_user_id,p_engine_id,p_redirect_path,
    now()+make_interval(secs=>ttl)
  );
  return true;
end;
$$;

revoke all on function public.orbitfs_create_engine_session_handoff(text,text,text,text,text,integer) from public;
grant execute on function public.orbitfs_create_engine_session_handoff(text,text,text,text,text,integer) to service_role;

create or replace function public.orbitfs_consume_engine_session_handoff(
  p_ticket_hash text,
  p_installation_id text
)
returns table(user_id text,engine_id text,redirect_path text)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if not private.orbitfs_server_secret_valid() then
    raise exception 'OrbitFS Engine authorization required' using errcode='42501';
  end if;

  return query
  update public.orbitfs_engine_session_handoffs h
     set consumed_at=now()
   where h.ticket_hash=lower(p_ticket_hash)
     and h.installation_id=p_installation_id
     and h.consumed_at is null
     and h.expires_at>now()
  returning h.user_id,h.engine_id,h.redirect_path;
end;
$$;

revoke all on function public.orbitfs_consume_engine_session_handoff(text,text) from public;
grant execute on function public.orbitfs_consume_engine_session_handoff(text,text) to anon, authenticated, service_role;

notify pgrst,'reload schema';
