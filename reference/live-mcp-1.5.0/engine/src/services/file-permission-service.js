import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(process.env.ORBITFS_BACKEND_ROOT || path.join(here, "../../../../../panel-backend"));
const statePath = path.join(backendRoot, "data", "state.json");
const defaults = Object.freeze({
  owner: { read: true, write: true, download: true, move: true, delete: true, create: true, share: true },
  editor: { read: true, write: true, download: true, move: true, delete: true, create: true, share: true },
  contributor: { read: true, write: true, download: true, move: false, delete: false, create: true, share: false },
  viewer: { read: true, write: false, download: false, move: false, delete: false, create: false, share: false }
});

async function readState() {
  return JSON.parse(await fs.readFile(statePath, "utf8"));
}
function clean(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
function same(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}
function denied(message, code = "FILE_PERMISSION_DENIED") {
  return Object.assign(new Error(message), { status: 403, code });
}
export async function effectiveFilePermissions(identity, workspaceId, subpath = "") {
  const state = await readState();
  const workspace = (state.workspaces || []).find((item) => item.id === workspaceId);
  if (!workspace) throw Object.assign(new Error("Workspace not found"), { status: 404, code: "WORKSPACE_NOT_FOUND" });
  const user = (state.users || []).find((item) => item.id === identity.userId || same(item.username, identity.username));
  if (!user) throw denied("Authenticated user is not present in OrbitFS", "USER_NOT_FOUND");

  const member = (state.members?.[workspaceId] || []).find((item) => item.user_id === user.id || same(item.username, user.username));
  let role = null;
  if (workspace.owner_id === user.id || same(workspace.owner_username, user.username)) role = "owner";
  else if (workspace.id === "admin-main") role = "viewer";
  else role = member?.permission || null;
  if (!role) throw denied("Workspace access denied", "WORKSPACE_ACCESS_DENIED");

  const relative = clean(subpath);
  const matches = (state.permissionOverrides?.[workspaceId] || [])
    .filter((item) => item.role === role && (!clean(item.path) || relative === clean(item.path) || relative.startsWith(clean(item.path) + "/")))
    .sort((a, b) => clean(b.path).length - clean(a.path).length);
  const base = workspace.id === "admin-main" && user.role !== "owner" && user.role !== "admin"
    ? defaults.viewer : (defaults[role] || defaults.viewer);
  return { permissions: { ...base, ...(matches[0]?.permissions || {}) }, role, matchedPath: matches[0]?.path || "", user, workspace };
}
export async function requireFilePermission(identity, workspaceId, subpath, action) {
  const result = await effectiveFilePermissions(identity, workspaceId, subpath);
  if (!result.permissions[action]) throw denied(`File permission required: ${action}`);
  return result;
}
