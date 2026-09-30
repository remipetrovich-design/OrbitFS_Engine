import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const server = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const vent = await fs.readFile(new URL('../src/tools/ventmode-tools.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `Missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to >= 0 ? to : source.length);
}

const filter = section(server, 'async function filterContextReadItems', 'async function loadPathsIntoContext');
assert(filter.includes('requireFilePermission(identity, workspaceId, item.path, "read")'));
assert(filter.includes('CONTEXT_REQUIRED_READ_DENIED'));
const loader = section(server, 'async function loadPathsIntoContext', 'async function loadDefaultsIntoContext');
assert(loader.includes('filterContextReadItems(workspaceId,items,identity,permissionErrors)'));
assert(loader.includes('loadDocumentItems(permitted,'));

const requiredWiring = [
  'loadPathsIntoContext(workspaceId,clientId,[{absolute:resolved.absolute,path:resolved.clean}],maxCharacters,policy,identity)',
  'loadPathsIntoContext(workspaceId,clientId,items,maxCharacters,policy,identity)',
  'loadBundleIntoContext(workspaceId,bundleId,clientId,maxFiles,cappedCharacters,identity,policy)',
  'loadDefaultsIntoContext(workspaceId,clientId,maxFiles,cappedCharacters,identity,',
  'runStartup(workspaceId,strength,clientId,identity,projectId)',
  'loadPathsIntoContext(workspaceId,clientId,[{absolute:resolved.absolute,path:resolved.clean}],250000,policy,identity)',
  'loadPathsIntoContext(workspaceId,clientId,items,receipt.limitCharacters||500000,effectiveAdminPolicy(workspaceId),identity)'
];for (const text of requiredWiring) assert(server.includes(text), `Missing context security wiring: ${text}`);

assert(server.includes('const appOnlyMeta={...meta,ui:{visibility:["app"]}}'));
for (const name of ['orbitfs_ui_state','list_workspace_entries']) {
  const start = server.indexOf(`server.registerTool("${name}"`);
  assert(start >= 0, `Missing ${name}`);
  const next = server.indexOf('server.registerTool(', start + 20);
  const block = server.slice(start, next >= 0 ? next : server.length);
  assert(block.includes('_meta:appOnlyMeta'), `${name} is not app-only`);
}

assert(vent.includes("const setupAppMeta={...meta,ui:{visibility:['app']}}"));
for (const name of ['ventmode_setup_get','ventmode_setup_browse','ventmode_setup_save','ventmode_setup_clear']) {
  const start = vent.indexOf(`server.registerTool('${name}'`);
  assert(start >= 0, `Missing ${name}`);
  const next = vent.indexOf('server.registerTool(', start + 20);
  const block = vent.slice(start, next >= 0 ? next : vent.length);
  assert(block.includes('_meta:setupAppMeta'), `${name} is not app-only`);
}

console.log('context-security smoke: context read gates + app-only visibility passed');