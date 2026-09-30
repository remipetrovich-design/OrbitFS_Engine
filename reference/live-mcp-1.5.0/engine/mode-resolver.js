function workspaceCoreActive(context = {}) {
  const state = context.s || context.state || context.panelState || null;
  const core = context.core || {};
  if (typeof core.workspaceModeEnabled === 'function') {
    try { return core.workspaceModeEnabled(state) !== false; } catch {}
  }
  if (typeof context.workspaceModeEnabled === 'function') {
    try { return context.workspaceModeEnabled(state) !== false; } catch {}
  }
  if (core.mcpApi?.requireWorkspaceCapability) return true;
  if (typeof core.requireWorkspace === 'function' && typeof core.requireWorkspaceCapability === 'function') return true;
  if (core.workspaces?.requireCapability) return true;
  return Array.isArray(state?.workspaces);
}

function publicFallbackEnabled(context = {}) {
  const cfg = context.config || {};
  return cfg.allowPublicFallback === true || context.allowPublicFallback === true;
}

export function resolveMode(context = {}) {
  const coreActive = workspaceCoreActive(context);
  const usePublicFallback = !coreActive && publicFallbackEnabled(context);
  return {
    mode: usePublicFallback ? 'public' : 'workspace',
    workspaceAddonActive: coreActive,
    workspaceCoreActive: coreActive,
    scopeId: usePublicFallback ? 'public' : null,
    fallback: 'public'
  };
}
export async function persistMode(context, result) {
  await context.db.execute(`INSERT INTO mcp_runtime_state (id,mode,workspace_addon_active,service_status,updated_at)
    VALUES (1,?,?, 'configured', NOW(3)) ON DUPLICATE KEY UPDATE mode=VALUES(mode),workspace_addon_active=VALUES(workspace_addon_active),updated_at=VALUES(updated_at)`,
    [result.mode, result.workspaceAddonActive ? 1 : 0]);
  return result;
}
