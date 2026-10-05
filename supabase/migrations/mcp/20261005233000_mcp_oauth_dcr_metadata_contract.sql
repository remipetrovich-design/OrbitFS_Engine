-- OrbitFS MCP OAuth dynamic client registration metadata contract.
-- Existing installations may have the original MCP OAuth client table without
-- the RFC 7591 metadata columns already used by the Panel DCR routes.
-- Keep this forward-only and idempotent so it is safe for both first install
-- database packages and later Engine/MCP updates.

alter table public.mcp_oauth_clients
  add column if not exists grant_types jsonb not null default '["authorization_code"]'::jsonb,
  add column if not exists response_types jsonb not null default '["code"]'::jsonb,
  add column if not exists tos_uri text,
  add column if not exists policy_uri text,
  add column if not exists jwks_uri text,
  add column if not exists contacts jsonb not null default '[]'::jsonb,
  add column if not exists registration_client_uri text,
  add column if not exists client_id_issued_at bigint;

update public.mcp_oauth_clients
set client_id_issued_at = extract(epoch from coalesce(created_at, now()))::bigint
where client_id_issued_at is null;

alter table public.mcp_oauth_clients
  alter column client_id_issued_at set not null;

notify pgrst, 'reload schema';
