import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { refreshOAuthIdentity, synchronizeOAuthAccess, oauthConfig } from "../oauth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditPath = path.join(here, "..", "data", "system-command-audit.jsonl");
const systemRoles = new Set(["owner", "admin"]);
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const systemToolOutputSchema = z.object({ ok: z.boolean(), message: z.string().optional(), systemRole: z.string().optional() }).passthrough();

async function panelState() {
  return JSON.parse(await fs.readFile(oauthConfig.panelStatePath, "utf8"));
}
function requireSystemRole(identity) {
  if (!systemRoles.has(String(identity.role || "").toLowerCase())) {
    throw Object.assign(new Error("System Owner or Admin required"), { status: 403, code: "SYSTEM_ROLE_REQUIRED" });
  }
}
async function audit(command, identity, result, details = {}) {
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, JSON.stringify({
    at: new Date().toISOString(), command, actorUserId: identity.userId || null,
    actorUsername: identity.username || null, actorRole: identity.role || null, result, details
  }) + "\n", "utf8");
}
function workspaceRolesFor(state, user) {
  const roles = [];
  for (const workspace of state.workspaces || []) {
    const member = (state.members?.[workspace.id] || []).find((item) =>
      item.user_id === user.id || same(item.username, user.username));
    let role = null;
    if (workspace.owner_id === user.id || same(workspace.owner_username, user.username)) role = "owner";
    else if (member) role = member.permission || member.role || "viewer";
    else if (workspace.is_public) role = "viewer";
    if (role) roles.push({ workspaceId: workspace.id, workspaceName: workspace.name, role });
  }
  return roles;
}
function response(text, structuredContent, meta) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, message: text, ...structuredContent },
    _meta: { ...meta, orbitfsUiState: structuredContent }
  };
}

export function registerSystemTools(server, deps) {
  const { requireLicence, identity, meta, refreshLicence, pingStore,
    loadContextState, ensureContextLibrarySchema } = deps;

  server.registerTool("refresh_perms", {
    title: "Refresh OrbitFS permissions",
    description: "Immediately reload the authenticated user system, workspace and file-permission authority from OrbitFS.",
    inputSchema: {}, outputSchema: systemToolOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async () => {
    requireLicence();
    const fresh = await refreshOAuthIdentity(identity);
    const state = await panelState();
    const user = (state.users || []).find((item) => item.id === fresh.userId);
    const workspaceRoles = workspaceRolesFor(state, user);
    const data = { systemRole: fresh.role, workspaceRoles, workspaceIds: fresh.workspaceIds };
    await audit("refresh_perms", fresh, "success", { workspaceCount: workspaceRoles.length });
    return response("OrbitFS permissions refreshed.", data, meta);
  });

  server.registerTool("get_user_roles", {
    title: "Get OrbitFS user roles",
    description: "Return the authenticated user current system role and roles in accessible workspaces.",
    inputSchema: { workspaceId: z.string().optional() },
    outputSchema: systemToolOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId }) => {
    requireLicence();
    const fresh = await refreshOAuthIdentity(identity);
    const state = await panelState();
    const user = (state.users || []).find((item) => item.id === fresh.userId);
    let workspaceRoles = workspaceRolesFor(state, user)
      .filter((item) => fresh.workspaceIds.includes(item.workspaceId));
    if (workspaceId) workspaceRoles = workspaceRoles.filter((item) => item.workspaceId === workspaceId);
    await audit("get_user_roles", fresh, "success", { workspaceId: workspaceId || null });
    return response("System role: " + fresh.role + ". Workspace roles: " + workspaceRoles.length + ".",
      { systemRole: fresh.role, workspaceRoles }, meta);
  });

  server.registerTool("refresh_config", {
    title: "Refresh OrbitFS system configuration",
    description: "System Owner/Admin only. Reload and validate the MCP licence, state, context, schema and data-store connection.",
    inputSchema: {}, outputSchema: systemToolOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async () => {
    requireLicence(); requireSystemRole(identity);
    try {
      const [license, store] = await Promise.all([refreshLicence(true), pingStore()]);
      await loadContextState();
      await ensureContextLibrarySchema();
      const data = { license, store, refreshedAt: new Date().toISOString() };
      await audit("refresh_config", identity, "success", { store });
      return response("OrbitFS system configuration refreshed.", data, meta);
    } catch (error) {
      await audit("refresh_config", identity, "failed", { code: error.code || null, message: error.message });
      throw error;
    }
  });

  server.registerTool("global_sync", {
    title: "Force OrbitFS global sync",
    description: "System Owner/Admin only. Force all OAuth roles and workspace grants to match panel state, then reload MCP system state.",
    inputSchema: { reason: z.string().min(3).max(500) },
    outputSchema: systemToolOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ reason }) => {
    requireLicence(); requireSystemRole(identity);
    try {
      const oauth = await synchronizeOAuthAccess();
      await loadContextState();
      await ensureContextLibrarySchema();
      const store = await pingStore();
      const data = { oauth, store, reason, syncedAt: new Date().toISOString() };
      await audit("global_sync", identity, "success", { reason, oauth, store });
      return response("OrbitFS global sync completed.", data, meta);
    } catch (error) {
      await audit("global_sync", identity, "failed", { reason, code: error.code || null, message: error.message });
      throw error;
    }
  });
}
