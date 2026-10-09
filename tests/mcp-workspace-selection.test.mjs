import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpClientWorkspaceIds, isSelectableMcpWorkspace } from '../src/addons/mcp/server/mcp-workspace-selection.ts';

const publicWorkspace = { status:'active',visibility:'public',mcp_system_enabled:true,mcp_ui_enabled:true };
const privateWorkspace = { status:'active',visibility:'private',mcp_system_enabled:true,mcp_ui_enabled:true };

test('OAuth clients use current workspace grants instead of their stale login snapshot', () => {
  assert.deepEqual(mcpClientWorkspaceIds({ metadata:{oauth:true}, workspace_ids:['previous-public'] }), []);
});
test('explicitly restricted OAuth clients preserve their workspace allowlist', () => {
  assert.deepEqual(mcpClientWorkspaceIds({ metadata:{oauth:true,workspaceGrantMode:'explicit'},workspace_ids:['ws-a'] }), ['ws-a']);
});
test('other clients retain their stored allowlist without widening access', () => {
  assert.deepEqual(mcpClientWorkspaceIds({workspace_ids:['ws-a','ws-a','ws-b']}), ['ws-a','ws-b']);
});
test('private MCP-enabled workspace is available when public visibility is disabled', () => {
  assert.equal(isSelectableMcpWorkspace(privateWorkspace, {publicWorkspaceVisible:false}), true);
});
test('hidden Public Workspace is omitted from the MCP selector', () => {
  assert.equal(isSelectableMcpWorkspace(publicWorkspace, {publicWorkspaceVisible:false}), false);
});
test('Public Workspace is selectable when the admin makes it visible', () => {
  assert.equal(isSelectableMcpWorkspace(publicWorkspace, {publicWorkspaceVisible:true}), true);
});
test('disabled, suspended and archived workspaces are not offered', () => {
  assert.equal(isSelectableMcpWorkspace({...privateWorkspace,mcp_ui_enabled:false},{}),false);
  assert.equal(isSelectableMcpWorkspace({...privateWorkspace,mcp_system_enabled:false},{}),false);
  assert.equal(isSelectableMcpWorkspace({...privateWorkspace,status:'suspended'},{}),false);
  assert.equal(isSelectableMcpWorkspace({...privateWorkspace,status:'archived'},{}),false);
});
