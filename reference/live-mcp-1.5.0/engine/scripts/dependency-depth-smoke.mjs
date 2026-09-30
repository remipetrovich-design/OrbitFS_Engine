import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.MYSQL_DATABASE = process.env.MCP_TEST_DATABASE || 'orbitfs_mcp_depth_test';
const { ensureContextLibrarySchema, createContextBundle, saveContextBundle } = await import('../src/context-library.js');

const workspaceId = 'depth-test-workspace';
const ids = { A: crypto.randomUUID(), B: crypto.randomUUID(), C: crypto.randomUUID() };
await ensureContextLibrarySchema();
for (const name of ['A','B','C']) {
  await createContextBundle({ workspaceId, id: ids[name], name });
}
await saveContextBundle({ workspaceId, bundleId: ids.C, name: 'C', dependencies: [], maxDependencyDepth: 5 });
await saveContextBundle({ workspaceId, bundleId: ids.B, name: 'B', dependencies: [{ bundleId: ids.C }], maxDependencyDepth: 5 });
await assert.rejects(
  () => saveContextBundle({ workspaceId, bundleId: ids.A, name: 'A', dependencies: [{ bundleId: ids.B }], maxDependencyDepth: 1 }),
  (error) => error?.code === 'CCS_DEPENDENCY_DEPTH_LIMIT'
);
await saveContextBundle({ workspaceId, bundleId: ids.A, name: 'A', dependencies: [{ bundleId: ids.B }], maxDependencyDepth: 2 });
console.log(JSON.stringify({ ok: true, checks: 2, graph: 'A>B>C' }));
