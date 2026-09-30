import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbitfs-system-tools-smoke-'));
const panelStatePath = path.join(fixtureRoot, 'state.json');
const oauthStatePath = path.join(fixtureRoot, 'oauth-state.json');
const owner = { id: 'owner-1', username: 'owner', role: 'owner', status: 'active' };
const regular = { id: 'user-1', username: 'member', role: 'user', status: 'active' };
const workspace = { id: 'workspace-1', name: 'Fixture workspace', status: 'active', owner_id: owner.id, mcp_system_enabled: true, mcp_ui_enabled: true };
await fs.writeFile(panelStatePath, JSON.stringify({ users: [owner, regular], workspaces: [workspace], members: { [workspace.id]: [{ user_id: regular.id, role: 'member', mcp_enabled: true }] } }));
process.env.ORBITFS_PANEL_STATE_PATH = panelStatePath;
process.env.ORBITFS_MCP_OAUTH_STATE = oauthStatePath;
const { registerSystemTools } = await import('../src/tools/system-tools.js?smoke=' + Date.now());

function capture(identity) {
  const tools = new Map();
  const server = { registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } };
  registerSystemTools(server, {
    requireLicence() {}, identity, meta: {},
    refreshLicence: async () => ({ licensed: true }),
    pingStore: async () => ({ mysql: true, state: true }),
    loadContextState: async () => {}, ensureContextLibrarySchema: async () => {}
  });
  return tools;
}
const ownerIdentity = { userId: owner.id, username: owner.username, role: owner.role, workspaceIds: [workspace.id] };
const tools = capture(ownerIdentity);
assert.deepEqual([...tools.keys()], ['refresh_perms', 'get_user_roles', 'refresh_config', 'global_sync']);
const refreshed = await tools.get('refresh_perms').handler({});
assert.equal(refreshed._meta.orbitfsUiState.systemRole, owner.role);
const roles = await tools.get('get_user_roles').handler({});
assert.equal(roles._meta.orbitfsUiState.systemRole, owner.role);
const config = await tools.get('refresh_config').handler({});
assert.equal(config._meta.orbitfsUiState.store.mysql, true);
const sync = await tools.get('global_sync').handler({ reason: 'system tool smoke test' });
assert.equal(typeof sync._meta.orbitfsUiState.oauth.updated, 'number');

const deniedTools = capture({ userId: regular.id, username: regular.username, role: regular.role, workspaceIds: [workspace.id] });
await assert.rejects(() => deniedTools.get('refresh_config').handler({}), (error) => error.code === 'SYSTEM_ROLE_REQUIRED');
await assert.rejects(() => deniedTools.get('global_sync').handler({ reason: 'denial test' }), (error) => error.code === 'SYSTEM_ROLE_REQUIRED');
await fs.rm(fixtureRoot, { recursive: true, force: true });
console.log('system-tools-smoke: 8 checks passed');
