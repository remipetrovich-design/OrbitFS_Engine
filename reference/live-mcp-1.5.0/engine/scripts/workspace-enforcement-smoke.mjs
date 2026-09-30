import assert from 'node:assert/strict';
import { workspaceIdsFor, effectiveWorkspaceIds } from '../src/oauth.js';
import { filterWorkspaces } from '../src/identity.js';

const user = { id: 'user-1', username: 'Member', role: 'user', status: 'active' };
const base = {
  users: [user],
  workspaces: [
    { id: 'allowed', status: 'active', owner_id: 'owner-1', mcp_ui_enabled: true },
    { id: 'owner-disabled', status: 'active', owner_id: 'user-1', mcp_ui_enabled: false },
    { id: 'master-disabled', status: 'active', owner_id: 'user-1', mcp_ui_enabled: true, mcp_system_enabled: false },
    { id: 'not-member', status: 'active', owner_id: 'owner-2', mcp_ui_enabled: true }
  ],
  members: {
    allowed: [{ user_id: 'user-1', permission: 'user', mcp_enabled: true }],
    'not-member': [{ user_id: 'other', mcp_enabled: true }]
  }
};

assert.deepEqual(workspaceIdsFor(base, user), ['allowed']);
assert.deepEqual(filterWorkspaces(base.workspaces, { role: 'owner', workspaceIds: ['allowed'] }).map((item) => item.id), ['allowed']);

const memberRevoked = structuredClone(base);
memberRevoked.members.allowed[0].mcp_enabled = false;
assert.deepEqual(workspaceIdsFor(memberRevoked, user), []);

const token = { userId: 'user-1', workspaceIds: ['allowed'], revokedWorkspaceIds: [] };
const denied = effectiveWorkspaceIds(memberRevoked, token);
assert.deepEqual(denied.workspaceIds, []);
assert.deepEqual(denied.revokedWorkspaceIds, ['allowed']);

const reenabled = effectiveWorkspaceIds(base, { ...token, revokedWorkspaceIds: denied.revokedWorkspaceIds });
assert.deepEqual(reenabled.workspaceIds, ['allowed'], 're-enabled access must return without reconnecting');
assert.deepEqual(reenabled.revokedWorkspaceIds, [], 'stale revocation state must clear after access returns');

const masterRevoked = structuredClone(base);
masterRevoked.workspaces[0].mcp_system_enabled = false;
assert.deepEqual(effectiveWorkspaceIds(masterRevoked, token).workspaceIds, []);

const ownerDisabled = structuredClone(base);
ownerDisabled.workspaces[0].mcp_ui_enabled = false;
assert.deepEqual(effectiveWorkspaceIds(ownerDisabled, token).workspaceIds, []);

console.log(JSON.stringify({ ok: true, checks: 7, enforcement: ['workspace-switch', 'master-switch', 'member-access', 'membership-boundary', 'persistent-token-revocation'] }));
