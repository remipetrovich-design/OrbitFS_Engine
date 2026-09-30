const READ = 'orbitfs:read';
const WRITE = 'orbitfs:write';
const policy = (scopes, clientWrite = false, basePermission = 'mcp_use') => Object.freeze({ scopes, clientWrite, basePermission });

export const TOOL_SECURITY = Object.freeze({
  orbitfs: policy([READ]),
  orbitfs_ui_state: policy([READ]),
  studio: policy([READ], false, 'mcp_use + studio_view'),
  ventmode: policy([READ, WRITE], true, 'mcp_use + studio_view'),
  studio_ui_state: policy([READ], false, 'mcp_use + studio_view'),
  studio_set_mode: policy([READ, WRITE], true, 'mcp_use + studio_view'),
  studio_get_schema: policy([READ], false, 'mcp_use + studio_view'),
  studio_list_records: policy([READ], false, 'mcp_use + studio_view'),
  studio_get_record: policy([READ], false, 'mcp_use + studio_view'),
  studio_create_record: policy([READ, WRITE], true, 'mcp_use + studio_create'),
  studio_update_record: policy([READ, WRITE], true, 'mcp_use + studio_edit'),
  studio_append: policy([READ, WRITE], true, 'mcp_use + studio_edit/manage_sessions'),
  studio_record_action: policy([READ, WRITE], true, 'mcp_use + studio_finalize/archive/edit'),
  studio_submit_approval: policy([READ, WRITE], true, 'mcp_use + studio_finalize + Library approval'),
  studio_analyse_routing: policy([READ], false, 'mcp_use + studio_view'),
  studio_list_revisions: policy([READ], false, 'mcp_use + studio_view'),
  studio_list_links: policy([READ], false, 'mcp_use + studio_view'),
  studio_manage_link: policy([READ, WRITE], true, 'mcp_use + studio_manage_links'),
  studio_create_document_from_record: policy([READ, WRITE], true, 'mcp_use + studio_create/manage_links'),
  studio_session: policy([READ, WRITE], true, 'mcp_use + studio_manage_sessions/create'),
  knowledge_overview: policy([READ], false, 'mcp_use + knowledge read'),
  search_knowledge: policy([READ], false, 'mcp_use + knowledge read'),
  get_knowledge_section: policy([READ], false, 'mcp_use + knowledge read'),
  get_knowledge_lineage: policy([READ], false, 'mcp_use + knowledge read'),
  get_knowledge_impact: policy([READ], false, 'mcp_use + knowledge read'),
  load_knowledge_item: policy([READ], false, 'mcp_use + knowledge read'),
  resolve_knowledge_target: policy([READ], false, 'mcp_use + knowledge read'),
  refresh_ui: policy([READ]),
  load_defaults: policy([READ, WRITE], true, 'mcp_use + context + source read'),
  run_startup: policy([READ, WRITE], true, 'mcp_use + startup/context + source read'),
  context_status: policy([READ]),
  context_explain: policy([READ]),
  get_active_context: policy([READ]),
  load_file: policy([READ, WRITE], true, 'file:read + context'),
  load_folder: policy([READ, WRITE], true, 'file:read + context'),
  list_context_bundles: policy([READ]),
  load_context_bundle: policy([READ, WRITE], true, 'bundle + file/profile read + context'),
  unload_context_bundle: policy([WRITE], true, 'context'),
  list_workspace_entries: policy([READ], false, 'file:read'),
  view_profile: policy([READ], false, 'profile:view'),
  list_profiles: policy([READ], false, 'profile:view'),
  load_profile: policy([READ, WRITE], true, 'profile:load_context + referenced file:read'),
  remove_context_file: policy([WRITE], true, 'context'),
  reload_changed_context: policy([READ, WRITE], true, 'file:read + context'),
  clear_context: policy([WRITE], true, 'context'),
  search_files: policy([READ], false, 'file:read'),
  read_file: policy([READ], false, 'file:read'),
  write_file: policy([WRITE], true, 'file:create/write'),
  upload_chatgpt_file: policy([WRITE], true, 'file:create'),
  create_folder: policy([WRITE], true, 'file:create'),
  move_entry: policy([WRITE], true, 'file:move + destination create'),
  delete_entry: policy([WRITE], true, 'file:delete'),
  file_info: policy([READ], false, 'file:read'),
  read_many: policy([READ], false, 'file:read'),
  edit_file: policy([WRITE], true, 'file:write'),

  save_profile_changes: policy([WRITE], true, 'profile:edit or queue_profile_commands'),
  create_profile: policy([WRITE], true, 'profile:create or queue_profile_commands'),
  archive_profile: policy([WRITE], true, 'profile:delete or queue_profile_commands'),
  repair_profiles: policy([WRITE], true, 'profile:repair or queue_profile_commands'),
  import_profile: policy([WRITE], true, 'profile:import or queue_profile_commands'),
  export_profile: policy([READ], false, 'profile:export'),

  refresh_perms: policy([READ]),
  get_user_roles: policy([READ]),
  refresh_config: policy([WRITE], true, 'system owner/admin'),
  global_sync: policy([WRITE], true, 'system owner/admin'),

  workspace: policy([READ]),
  loadworkspace: policy([READ, WRITE], true, 'mcp_use + session workspace state'),
});

export function toolSecurityPolicy(name) {
  const value = TOOL_SECURITY[name];
  if (!value) throw Object.assign(new Error(`No OrbitFS security policy registered for tool: ${name}`), { status: 500, code: 'TOOL_SECURITY_POLICY_MISSING' });
  return value;
}

export function securitySchemesForTool(name) {
  const value = toolSecurityPolicy(name);
  return [{ type: 'oauth2', scopes: [...value.scopes] }];
}
export function requireToolAuthorization(identity, name, challenge) {
  const value = toolSecurityPolicy(name);
  const granted = new Set(Array.isArray(identity?.scopes) ? identity.scopes : []);
  const missing = value.scopes.filter((scope) => !granted.has(scope));
  if (missing.length) {
    const description = `OrbitFS tool ${name} requires ${value.scopes.join(' ')}.`;
    const error = Object.assign(new Error(description), {
      status: 403,
      code: 'OAUTH_INSUFFICIENT_SCOPE',
      requiredScopes: [...value.scopes]
    });
    if (typeof challenge === 'function') error.wwwAuthenticate = challenge(value.scopes, 'insufficient_scope', description);
    throw error;
  }
  if (value.clientWrite && identity?.clientPermissions?.write === false) {
    throw Object.assign(new Error('Write access is disabled for this MCP client'), {
      status: 403,
      code: 'CLIENT_WRITE_DISABLED'
    });
  }
  return value;
}
