const base = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3942';
const accessToken = process.env.ORBITFS_SMOKE_ACCESS_TOKEN;
if (!accessToken) throw new Error('ORBITFS_SMOKE_ACCESS_TOKEN is required; anonymous MCP testing is forbidden');
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${accessToken}`,
  'x-orbitfs-client-id': 'context-receipt-smoke'
};
async function rpc(id, method, params = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text}`);
  const line = text.split('\n').find((item) => item.startsWith('data: '));
  const payload = JSON.parse(line ? line.slice(6) : text);
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}
const initialized = await rpc(1, 'initialize', {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'context-receipt-smoke', version: '1.0.0' }
});
const listed = await rpc(2, 'tools/list');
const names = listed.tools.map((tool) => tool.name);
for (const required of ['run_startup', 'get_active_context', 'clear_context']) {
  if (!names.includes(required)) throw new Error(`Missing tool ${required}`);
}
const dashboard = await rpc(3, 'tools/call', {
  name: 'orbitfs_mcp_dashboard', arguments: { workspaceId: 'default' }
});
const workspaceId = dashboard.structuredContent?.workspaceId;
if (!workspaceId) throw new Error('No workspace resolved');
const startup = await rpc(4, 'tools/call', {
  name: 'run_startup', arguments: { workspaceId, strength: 'low' }
});
const receipt = startup.structuredContent?.receipt;
if (!receipt?.contextId) throw new Error('Startup returned no context receipt');
if (receipt.transferredCount !== receipt.files.length) throw new Error('Receipt count mismatch');
if (!startup.content?.[0]?.text?.includes('ORBITFS-CONTEXT-READ-7429')) {
  throw new Error('Startup did not transfer the actual document contents');
}
if (process.env.TEST_SOURCE_FILE) {
  const fs = await import('node:fs/promises');
  await fs.appendFile(process.env.TEST_SOURCE_FILE, '\nChanged after loading.');
}
const active = await rpc(5, 'tools/call', {
  name: 'get_active_context', arguments: { workspaceId }
});
if (active.structuredContent?.activeContext?.contextId !== receipt.contextId) {
  throw new Error('Persisted active context does not match startup receipt');
}
if (process.env.TEST_SOURCE_FILE && active.structuredContent?.changeStatus?.outdated !== true) {
  throw new Error('Changed source was not marked outdated');
}
await rpc(6, 'tools/call', { name: 'clear_context', arguments: { workspaceId } });
const cleared = await rpc(7, 'tools/call', {
  name: 'get_active_context', arguments: { workspaceId }
});
if (cleared.structuredContent?.activeContext !== null) throw new Error('Context was not cleared');
console.log(JSON.stringify({
  ok: true,
  protocolVersion: initialized.protocolVersion,
  tools: names,
  workspaceId,
  contextId: receipt.contextId,
  selectedCount: receipt.selectedCount,
  transferredCount: receipt.transferredCount,
  failedCount: receipt.failedCount,
  charactersTransferred: receipt.charactersTransferred,
  persisted: true,
  cleared: true
}, null, 2));
