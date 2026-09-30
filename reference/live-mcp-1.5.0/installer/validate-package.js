import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/(.:)/, '$1'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const manifest = readJson(path.join(root, 'plugin.json'));
const pkg = readJson(path.join(root, 'package.json'));
const required = [
  'plugin.json', 'config.schema.json', 'installer/lifecycle.js', 'installer/build-package.js',
  'backend/index.js', 'backend/routes.js',
  'migrations/001_initial.sql', 'migrations/002_context_library.sql',
  'migrations/003_context_assignments.sql',
  'migrations/004_preset_metadata.sql',
  'migrations/005_profile_attachments.sql', 'migrations/006_repair_legacy_core_tables.sql',
  'migrations/007_runtime_workspace_schema.sql',
  'frontend/registration/navigation.json',
  'frontend/routes/mcp/oss/+page.svelte',
  'frontend/routes/mcp/ccs/+page.svelte',
  'frontend/routes/mcp/projects/+page.svelte',
  'frontend/routes/admin/mcp/runtime/+page.svelte',
  'frontend/lib/file-actions.svelte',
  'frontend/lib/folder-actions.svelte',
  'frontend/lib/file-view-actions.svelte',
  'engine/server.js', 'engine/src/server.js', 'engine/src/store.js', 'engine/src/widget.html',
  'engine/src/tools/file-tools.js', 'engine/scripts/file-tools-smoke.mjs',
  'engine/src/license.js', 'engine/src/oauth.js', 'engine/src/identity.js',
  'engine/src/document-loader.js', 'engine/src/context-store.js',
  'engine/src/context-library.js',
  'engine/src/services/dashboard-service.js',
  'engine/src/services/session-registry-service.js',
  'engine/scripts/protocol-smoke.mjs',
  'engine/scripts/context-receipt-smoke.mjs',
  'engine/scripts/load-tools-smoke.mjs',
  'engine/scripts/context-library-smoke.mjs',
  'engine/scripts/assigned-format-smoke.mjs',
  'engine/node_modules/@modelcontextprotocol/sdk/package.json',
  'engine/node_modules/@modelcontextprotocol/ext-apps/package.json'
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}`);
}
if (manifest.id !== 'mcp' || manifest.version !== pkg.version) throw new Error('MCP package versions are inconsistent');
const mergedWorkspaceCoreId = 'workspace' + '-core';
if (manifest.optionalIntegrations?.workspaces || manifest.dependencies?.addons?.some((item) => item.id === mergedWorkspaceCoreId)) throw new Error('Merged workspace core must not be declared as an add-on dependency');
const entry = fs.readFileSync(path.join(root, 'engine/server.js'), 'utf8');
if (!entry.includes('./src/server.js')) throw new Error('MCP engine entry is still a placeholder');
const engine = fs.readFileSync(path.join(root, 'engine/src/server.js'), 'utf8');
if(!engine.includes('ui://orbitfs/studio-v4.html')) throw new Error('MCP Studio v4 UI resource is missing');
for (const marker of [
  'McpServer', 'createMcpHandler', 'toNodeHandler', 'registerAppResource', 'registerAppTool', 'Open OrbitFS', 'runStartup', 'server.registerTool("run_startup"', 'presetDisplayName',
  'buildDashboardSnapshot', 'touchSession', 'listSessions',
  'get_active_context', 'load_file', 'load_folder',
  'list_context_bundles', 'load_context_bundle', 'loadProfileEntries', 'entry.attachmentType === \'profile\'', 'PROFILE_ACCESS_DENIED', 'clear_context',
  '/control/context/:workspaceId', 'reload-changed', 'load-file', 'load-folder'
]) {
  if (!engine.includes(marker)) throw new Error(`MCP engine missing ${marker}`);
}
const library = fs.readFileSync(path.join(root, 'engine/src/context-library.js'), 'utf8');
for (const marker of [
  'createContextBundle', 'saveContextBundle', 'deleteContextBundle',
  'resolveContextBundle', 'getPresetBundleAssignments',
  'saveProjectBundleAssignments', 'resolveAssignedBundles',
  'getPresetMetadata', 'savePresetMetadata', 'preset_name_changed', 'normalizePresetDisplayName'
]) {
  if (!library.includes(marker)) throw new Error(`Context Library missing ${marker}`);
}
const studioTools = fs.readFileSync(path.join(root, 'engine/src/tools/studio-tools.js'), 'utf8');
for (const marker of ['studio_analyse_routing','profileTargetId','profileSectionId']) if (!studioTools.includes(marker)) throw new Error(`MCP Studio integration missing ${marker}`);
const routes = fs.readFileSync(path.join(root, 'backend/routes.js'), 'utf8');
for (const marker of ['context-bundles', 'preset-bundles', 'preset-metadata', 'active-context', 'remove-file', 'load-file', 'load-folder', 'appUi', 'oauth']) {
  if (!routes.includes(marker)) throw new Error(`Plugin backend missing ${marker}`);
}
const lifecycle = fs.readFileSync(path.join(root, 'installer/lifecycle.js'), 'utf8');
for (const marker of ['resolveCoreDatabase', 'ORBITFS_CONTROL_TOKEN', 'ORBITFS_MCP_RESOURCE', 'ORBITFS_MCP_ISSUER', 'ORBITFS_MCP_OAUTH_STATE', 'autoStart', '003_context_assignments.sql', '004_preset_metadata.sql']) {
  if (!lifecycle.includes(marker)) throw new Error(`Lifecycle missing ${marker}`);
}
const fileTools = fs.readFileSync(path.join(root, 'engine/src/tools/file-tools.js'), 'utf8');
for (const marker of ['upload_chatgpt_file', 'openai/fileParams', 'ORBITFS_FILE_TRANSFER_INTENT_REQUIRED', 'move_entry', 'delete_entry', 'create_folder']) {
  if (!fileTools.includes(marker)) throw new Error(`MCP file tools missing ${marker}`);
}
const widget = fs.readFileSync(path.join(root, 'engine/src/widget.html'), 'utf8');
for (const marker of ['files.list', 'files.search', 'requestLibraryImport', 'downloadOrbitFile', 'Import / upload', 'New folder']) {
  if (!widget.includes(marker)) throw new Error(`ChatGPT widget missing ${marker}`);
}
const builder = fs.readFileSync(path.join(root, 'installer/build-package.js'), 'utf8');
for (const marker of ['engine/src/data', 'patchtmp', '.orbitfs-config.json', 'canonicalizeStage', 'canonicalTimestamp']) if (!builder.includes(marker)) throw new Error(`Package builder missing exclusion ${marker}`);

const store = fs.readFileSync(path.join(root, 'engine/src/store.js'), 'utf8');
if (!store.includes('ORBITFS_MCP_MODE') || !store.includes('Public Workspace')) throw new Error('Public storage fallback is missing');

const runtimePage = fs.readFileSync(path.join(root, 'frontend/routes/admin/mcp/runtime/+page.svelte'), 'utf8');
for (const marker of ['MCP Control Token', '/mcp/runtime', 'connectorPath', 'workspaceIntegration']) {
  if (!runtimePage.includes(marker)) throw new Error(`MCP runtime panel missing ${marker}`);
}

const nav = readJson(path.join(root, 'frontend/registration/navigation.json'));
for (const entry of [...(nav.routes || []), ...(nav.slots || [])]) {
  const component = String(entry?.component || '').trim();
  if (!component) throw new Error('MCP frontend registration is missing a component path');
  const target = path.resolve(root, component);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`MCP frontend component escapes package root: ${component}`);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Missing MCP frontend component: ${component}`);
}
for (const route of ['/mcp/oss', '/mcp/ccs', '/mcp/projects', '/admin/mcp/runtime']) {
  if (!nav.routes?.some((item) => item.path === route)) throw new Error(`MCP route missing ${route}`);
}
for (const slot of ['file-actions', 'folder-actions', 'file-view-actions']) {
  if (!nav.slots?.some((item) => item.slot === slot)) throw new Error(`MCP slot missing ${slot}`);
}
const sqlText = ['001_initial.sql', '002_context_library.sql', '003_context_assignments.sql', '004_preset_metadata.sql', '005_profile_attachments.sql', '006_repair_legacy_core_tables.sql', '007_runtime_workspace_schema.sql']
  .map((name) => fs.readFileSync(path.join(root, 'migrations', name), 'utf8')).join('\n');
const tables = [...sqlText.matchAll(/CREATE TABLE IF NOT EXISTS\s+(mcp_[a-z0-9_]+)/gi)].map((match) => match[1]);
if (new Set(tables).size < 13) throw new Error('Expected full MCP/context schema tables');
console.log(JSON.stringify({
  ok: true,
  id: manifest.id,
  version: manifest.version,
  files: required.length,
  tables: new Set(tables).size,
  realEngine: true,
  contextEngine: true,
  contextLibrary: true,
  panelRoutes: nav.routes.length
}, null, 2));

