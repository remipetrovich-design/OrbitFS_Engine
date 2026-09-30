import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { mergeContextItems, normalizeContextItem } from "./context-ownership.js";

const stateFile = path.resolve(process.env.ORBITFS_CONTEXT_STATE || "./data/active-context.json");
const contextScope = new AsyncLocalStorage();
let state = { schemaVersion: 3, contexts: {}, legacyContexts: {} };

function normalizeState(value) {
  if (value?.schemaVersion === 3 && value.contexts) return value;
  if (value?.schemaVersion === 2 && value.contexts) {
    return { schemaVersion: 3, contexts: {}, legacyContexts: value.contexts };
  }
  const legacyContexts = {};
  for (const [workspaceId, items] of Object.entries(value || {})) {
    if (Array.isArray(items)) legacyContexts[workspaceId] = { workspaceId, files: items, legacy: true };
  }
  return { schemaVersion: 3, contexts: {}, legacyContexts };
}

function scopedKey(workspaceId) {
  const scope = String(contextScope.getStore() || "internal");
  return `${encodeURIComponent(scope)}::${workspaceId}`;
}

export function runWithContextScope(scope, callback) {
  return contextScope.run(String(scope || "internal"), callback);
}

async function cleanupStaleContextTemps() {
  const dir = path.dirname(stateFile), prefix = `${path.basename(stateFile)}.`;
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

export async function loadContextState() {
  await cleanupStaleContextTemps();
  try { state = normalizeState(JSON.parse(await fs.readFile(stateFile, "utf8"))); }
  catch { state = { schemaVersion: 3, contexts: {}, legacyContexts: {} }; }
  return state;
}

async function persist() {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporary, stateFile);
}
export function getActiveContext(workspaceId) {
  return state.contexts[scopedKey(workspaceId)] || null;
}

export async function setActiveContext(workspaceId, receipt) {
  const key = scopedKey(workspaceId);
  state.contexts[key] = {
    ...receipt,
    workspaceId,
    updatedAt: new Date().toISOString()
  };
  await persist();
  return state.contexts[key];
}

export async function clearActiveContext(workspaceId) {
  const key = scopedKey(workspaceId);
  const previous = state.contexts[key] || null;
  delete state.contexts[key];
  await persist();
  return previous;
}

export function listActiveContexts() {
  const prefix = `${encodeURIComponent(String(contextScope.getStore() || "internal"))}::`;
  return Object.entries(state.contexts).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
}

export async function mergeActiveContext(workspaceId, patch) {
  const current = getActiveContext(workspaceId) || { workspaceId, files: [], errors: [], charactersTransferred: 0 };
  const byPath = new Map((current.files || []).map((item) => [String(item.path).toLowerCase(), normalizeContextItem(item)]));
  for (const item of patch.files || []) {
    const key = String(item.path).toLowerCase();
    byPath.set(key, byPath.has(key) ? mergeContextItems(byPath.get(key), item) : normalizeContextItem(item));
  }
  const files = [...byPath.values()];
  const errors = [...(current.errors || []), ...(patch.errors || [])];
  return setActiveContext(workspaceId, {
    ...current, ...patch, files, errors,
    transferredCount: files.filter((item) => item.transferred).length,
    charactersTransferred: files.reduce((sum, item) => sum + Number(item.characters || 0), 0),
    failedCount: errors.length,
    mergedAt: new Date().toISOString()
  });
}

export async function removeActiveContextFile(workspaceId, filePath) {
  const current = getActiveContext(workspaceId);
  if (!current) return null;
  const files = (current.files || []).filter((item) => item.path !== filePath);
  return setActiveContext(workspaceId, {
    ...current,
    files,
    transferredCount: files.length,
    openedCount: files.filter((item) => item.opened).length,
    extractedCount: files.filter((item) => item.extracted).length,
    charactersTransferred: files.reduce((sum, item) => sum + Number(item.characters || 0), 0),
    truncatedCount: files.filter((item) => item.truncated).length,
    completedAt: new Date().toISOString()
  });
}
