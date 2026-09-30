import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(process.env.ORBITFS_MCP_DATA_ROOT || path.join(here, '..', 'data'));
const panelSystemDataRoot = path.resolve(process.env.ORBITFS_PANEL_SYSTEM_DATA_ROOT || path.join(here, '..', '..', '..', '..', 'system-data'));

const DEFAULT_MASTER = Object.freeze({
  version: 3,
  autoLoadPanelWorkspaceContext: true,
  includeProfiles: true,
  allowSearch: true,
  allowContextLoad: true,
  loadOrder: ['panel-workspace-context','mcp-startup','mcp-chatgpt','project','preset','selected-context']
});
const DEFAULT_SETTINGS = Object.freeze({ searchMode: 'keyword', autoLoad: true, defaultPaths: [], folderTemplate: [] });
const DEFAULT_TEXT = Object.freeze({
  'load-order.md': '# MCP Load Order\n\nPanel workspace context -> MCP startup -> MCP ChatGPT behaviour -> Project -> Preset -> Selected context.\n',
  'startup-instructions.md': '# MCP Startup Instructions\n\nSet MCP-specific startup behaviour for this workspace.\n',
  'chatgpt-instructions.md': '# ChatGPT MCP Instructions\n\nSet how ChatGPT should use OrbitFS MCP for this workspace.\n'
});

function safeWorkspaceId(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function workspaceRoot(workspaceId) { return path.join(dataRoot, 'workspaces', safeWorkspaceId(workspaceId)); }
async function ensureFile(file, content) { try { await fs.access(file); } catch { await fs.writeFile(file, content, 'utf8'); } }

export async function readPanelWorkspaceContext(workspaceId) {
  const safeId = safeWorkspaceId(workspaceId);
  if (!safeId || safeId !== String(workspaceId || '')) throw new Error('Invalid workspace ID for workspace context');
  const root = path.join(panelSystemDataRoot, 'workspace-ai', safeId);
  const masterPath = path.join(root, 'master.json');
  let master;
  try { master = JSON.parse(await fs.readFile(masterPath, 'utf8')); }
  catch { return { workspaceId, enabled: false, root, master: null, files: {}, content: '' }; }
  if (master?.enabled === false) return { workspaceId, enabled: false, root, master, files: {}, content: '' };
  const order = Array.isArray(master?.loadOrder) ? master.loadOrder.map(String) : [];
  const files = {};
  const parts = [];
  const maxCharacters = Math.max(0, Number(master?.maxCharacters || 500000));
  let used = 0;
  for (const name of order) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === 'master.json') continue;
    try {
      let content = await fs.readFile(path.join(root, name), 'utf8');
      if (maxCharacters && used + content.length > maxCharacters) content = content.slice(0, Math.max(0, maxCharacters - used));
      files[name] = content;
      if (content) parts.push(content);
      used += content.length;
      if (maxCharacters && used >= maxCharacters) break;
    } catch {}
  }
  return { workspaceId, enabled: true, root, master, files, content: parts.filter(Boolean).join('\n\n') };
}

export async function ensureMcpWorkspaceConfig(workspaceId) {
  const root = workspaceRoot(workspaceId);
  await fs.mkdir(root, { recursive: true });
  await ensureFile(path.join(root, 'master.json'), JSON.stringify(DEFAULT_MASTER, null, 2));
  await ensureFile(path.join(root, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS, null, 2));
  for (const [name, content] of Object.entries(DEFAULT_TEXT)) await ensureFile(path.join(root, name), content);
  return root;
}
export async function readMcpWorkspaceConfig(workspaceId) {
  const root = await ensureMcpWorkspaceConfig(workspaceId);
  const readJson = async (name, fallback) => { try { return JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); } catch { return structuredClone(fallback); } };
  const master = await readJson('master.json', DEFAULT_MASTER);
  if (master.autoLoadPanelWorkspaceContext === undefined) master.autoLoadPanelWorkspaceContext = master.autoLoadPanelWorkspaceAi !== false;
  delete master.autoLoadPanelWorkspaceAi;
  const settings = await readJson('settings.json', DEFAULT_SETTINGS);
  settings.searchMode = 'keyword';
  return { workspaceId, master, settings, startupInstructions: await fs.readFile(path.join(root, 'startup-instructions.md'), 'utf8'), chatgptInstructions: await fs.readFile(path.join(root, 'chatgpt-instructions.md'), 'utf8'), loadOrderText: await fs.readFile(path.join(root, 'load-order.md'), 'utf8') };
}
export async function saveMcpWorkspaceConfig(workspaceId, input = {}) {
  const root = await ensureMcpWorkspaceConfig(workspaceId);
  const current = await readMcpWorkspaceConfig(workspaceId);
  const master = { ...current.master, ...(input.master || {}) };
  const settings = { ...current.settings, ...(input.settings || {}) };
  settings.searchMode = 'keyword';
  settings.defaultPaths = Array.isArray(settings.defaultPaths) ? settings.defaultPaths.map(String) : [];
  settings.folderTemplate = Array.isArray(settings.folderTemplate) ? settings.folderTemplate.map(String) : [];
  await fs.writeFile(path.join(root, 'master.json'), JSON.stringify(master, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  if (input.startupInstructions !== undefined) await fs.writeFile(path.join(root, 'startup-instructions.md'), String(input.startupInstructions), 'utf8');
  if (input.chatgptInstructions !== undefined) await fs.writeFile(path.join(root, 'chatgpt-instructions.md'), String(input.chatgptInstructions), 'utf8');
  if (input.loadOrderText !== undefined) await fs.writeFile(path.join(root, 'load-order.md'), String(input.loadOrderText), 'utf8');
  return readMcpWorkspaceConfig(workspaceId);
}
export function mcpWorkspaceDataRoot() { return dataRoot; }

// Legacy export retained for compatibility with older engine modules.
export const readPanelWorkspaceAi = readPanelWorkspaceContext;
