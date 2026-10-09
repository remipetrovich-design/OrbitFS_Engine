/**
 * OAuth clients use current workspace authority, not the snapshot stored
 * when their token was issued. Explicitly scoped clients retain their list.
 */
export function mcpClientWorkspaceIds(client: {
  workspace_ids?: unknown;
  metadata?: Record<string, unknown> | null;
} | null | undefined): string[] {
  if (client?.metadata?.oauth === true && client.metadata.workspaceGrantMode !== 'explicit') return [];
  return Array.isArray(client?.workspace_ids)
    ? [...new Set(client.workspace_ids.map(String).filter(Boolean))]
    : [];
}

/** The MCP workspace selector only advertises active, visible workspaces. */
export function isSelectableMcpWorkspace(
  workspace: {
    status?: string | null;
    visibility?: string | null;
    mcp_system_enabled?: boolean | null;
    mcp_ui_enabled?: boolean | null;
  },
  settings: { publicWorkspaceVisible?: boolean | null }
): boolean {
  if (workspace.status !== 'active') return false;
  if (workspace.mcp_system_enabled === false || workspace.mcp_ui_enabled !== true) return false;
  if (workspace.visibility === 'public' && settings.publicWorkspaceVisible === false) return false;
  return true;
}
