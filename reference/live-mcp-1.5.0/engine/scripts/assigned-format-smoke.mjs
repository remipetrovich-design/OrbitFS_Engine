const base = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3945';
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-orbitfs-client-id': 'assigned-format-smoke'
};
async function rpc(id, method, params = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const text = await response.text();
  const line = text.split('\n').find((item) => item.startsWith('data: '));
  const payload = JSON.parse(line ? line.slice(6) : text);
  if (!response.ok || payload.error || payload.result?.isError) throw new Error(text);
  return payload.result;
}
const initialized = await rpc(1, 'initialize', {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'assigned-format-smoke', version: '1.0.0' }
});
const startup = await rpc(2, 'tools/call', {
  name: 'run_startup', arguments: { workspaceId: 'public', strength: 'low' }
});
const text = startup.content?.[0]?.text || '';
for (const phrase of ['FORMAT-TXT-5512','FORMAT-MD-7734','FORMAT-DOCX-8841','FORMAT-PDF-9962']) {
  if (!text.includes(phrase)) throw new Error(`Missing transferred phrase ${phrase}`);
}
const receipt = startup.structuredContent?.receipt;
if (receipt?.transferredCount !== 4) throw new Error(`Expected 4 transferred files, got ${receipt?.transferredCount}`);
if (!receipt?.bundles?.some((bundle) => bundle.name === 'Format Bundle')) throw new Error('Assigned bundle missing from receipt');
const active = await rpc(3, 'tools/call', { name: 'get_active_context', arguments: { workspaceId: 'public' } });
if (active.structuredContent?.activeContext?.contextId !== receipt.contextId) throw new Error('Active receipt mismatch');
await rpc(4, 'tools/call', { name: 'clear_context', arguments: { workspaceId: 'public' } });
console.log(JSON.stringify({
  ok: true,
  protocolVersion: initialized.protocolVersion,
  transferredCount: receipt.transferredCount,
  charactersTransferred: receipt.charactersTransferred,
  bundle: receipt.bundles[0]?.name,
  formats: receipt.files.map((file) => file.extension)
}, null, 2));
