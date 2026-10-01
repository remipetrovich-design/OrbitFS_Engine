-- OrbitFS APEX component integration contract.
-- APEX currently stores canonical content in Base Library/Profile structures.
-- This migration owns only the Base integration flag needed by the component.

alter table public.orbitfs_workspaces
 add column if not exists apex_system_enabled boolean not null default true;

notify pgrst,'reload schema';
