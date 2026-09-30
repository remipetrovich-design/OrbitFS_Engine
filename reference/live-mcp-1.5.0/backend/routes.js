import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveMode } from '../engine/mode-resolver.js';
import { readMcpWorkspaceConfig, saveMcpWorkspaceConfig } from '../engine/src/mcp-workspace-config.js';
import { getAdminPolicy, saveAdminPolicy, effectivePolicy, policyError, requireSystemAdmin } from './policy.js';

const execFileAsync = promisify(execFile);
const addonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addonConfigPath = path.join(addonRoot, '.orbitfs-config.json');
const serviceConfigPath = path.resolve(addonRoot, '..', '..', 'service-host', 'OrbitFSMcpServer.service.conf');

async function readAddonConfig() {
  try { return JSON.parse(await readFile(addonConfigPath, 'utf8')); }
  catch { return {}; }
}

async function saveControlToken(token) {
  const config = await readAddonConfig();
  config.controlToken = token;
  await writeFile(addonConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  let serviceConfig = await readFile(serviceConfigPath, 'utf8');
  const line = `env.ORBITFS_CONTROL_TOKEN=${token}`;
  serviceConfig = /^env\.ORBITFS_CONTROL_TOKEN=.*$/m.test(serviceConfig)
    ? serviceConfig.replace(/^env\.ORBITFS_CONTROL_TOKEN=.*$/m, line)
    : serviceConfig.replace(/\s*$/, `\n${line}\n`);
  await writeFile(serviceConfigPath, serviceConfig, 'utf8');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Restart-Service -Name 'OrbitFSMcpServer' -Force"], { windowsHide: true });
}
import {
  ensureContextLibrarySchema,
  listContextBundles,
  getContextBundle,
  createContextBundle,
  saveContextBundle,
  deleteContextBundle,
  getPresetBundleAssignments,
  savePresetBundleAssignments,
  getProjectBundleAssignments,
  saveProjectBundleAssignments,
  getPresetMetadata,
  savePresetMetadata,
  getDefaultProfileSelections,
  saveDefaultProfileSelections
} from '../engine/src/context-library.js';

export const addonId = 'mcp';

async function requireWorkspaceCapability(context, workspaceId, capability) {
  const { core, user } = context;
  if (core.mcpApi?.requireWorkspaceCapability) return core.mcpApi.requireWorkspaceCapability(workspaceId, user, capability);
  if (core.requireWorkspaceCapability && core.requireWorkspace) {
    const workspace = core.requireWorkspace(context.s, workspaceId);
    return core.requireWorkspaceCapability(context.s, workspace, user, capability);
  }
  if (core.workspaces?.requireCapability) return core.workspaces.requireCapability(workspaceId, user, capability);
  if (['owner', 'admin'].includes(String(user?.role || '').toLowerCase())) return true;
  throw Object.assign(new Error('Workspace permission denied'), { status: 403, code: 'WORKSPACE_PERMISSION_DENIED' });
}

async function handleContextLibrary(context) {
  const { req, parts, core, user } = context;
  if (parts[1] !== 'workspaces' || !parts[2] || parts[3] !== 'context-bundles') return null;
  const workspaceId = parts[2], bundleId = parts[4] || null;
  await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_startup');
  await ensureContextLibrarySchema();
  const policy = effectivePolicy(await getAdminPolicy(), workspaceId);
  if (!policy.ccs.enabled) throw policyError('Complex Context System is disabled for this workspace', 'CCS_DISABLED');
  if (req.method === 'GET' && !bundleId) return { bundles: await listContextBundles(workspaceId), policy: policy.ccs };
  if (req.method === 'GET' && bundleId) return { bundle: await getContextBundle(workspaceId, bundleId) };
  if (req.method === 'POST' && !bundleId) {
    const existing = await listContextBundles(workspaceId);
    if (existing.length >= policy.ccs.maxBundlesPerWorkspace) throw policyError(`Workspace bundle limit reached (${policy.ccs.maxBundlesPerWorkspace})`, 'CCS_BUNDLE_LIMIT');
    const body = await core.readBody(req);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const dependencies = Array.isArray(body.dependencies) ? body.dependencies : [];
    if (entries.length > policy.ccs.maxEntriesPerBundle) throw policyError(`Bundle entry limit is ${policy.ccs.maxEntriesPerBundle}`, 'CCS_ENTRY_LIMIT');
    if (dependencies.length > policy.ccs.maxDependenciesPerBundle) throw policyError(`Bundle dependency limit is ${policy.ccs.maxDependenciesPerBundle}`, 'CCS_DEPENDENCY_LIMIT');
    if (!policy.ccs.allowProfiles && entries.some((entry) => entry.attachmentType === 'profile' || entry.type === 'profile' || entry.profile === true)) throw policyError('Profiles are disabled by MCP Admin policy', 'CCS_PROFILES_DISABLED');
    const id = crypto.randomUUID();
    await createContextBundle({
      workspaceId, id, name: body.name, description: body.description || '',
      enabled: body.enabled !== false, userId: user?.id || null
    });
    try {
      return {
        bundle: await saveContextBundle({
          workspaceId, bundleId: id, name: body.name, description: body.description || '',
          enabled: body.enabled !== false, entries, dependencies,
          maxDependencyDepth: policy.ccs.maxDependencyDepth
        })
      };
    } catch (error) {
      await deleteContextBundle(workspaceId, id).catch(() => {});
      throw error;
    }
  }
  if (req.method === 'PUT' && bundleId) {
    const body = await core.readBody(req);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const dependencies = Array.isArray(body.dependencies) ? body.dependencies : [];
    if (entries.length > policy.ccs.maxEntriesPerBundle) throw policyError(`Bundle entry limit is ${policy.ccs.maxEntriesPerBundle}`, 'CCS_ENTRY_LIMIT');
    if (dependencies.length > policy.ccs.maxDependenciesPerBundle) throw policyError(`Bundle dependency limit is ${policy.ccs.maxDependenciesPerBundle}`, 'CCS_DEPENDENCY_LIMIT');
    if (!policy.ccs.allowProfiles && entries.some((entry) => entry.attachmentType === 'profile' || entry.type === 'profile' || entry.profile === true)) throw policyError('Profiles are disabled by MCP Admin policy', 'CCS_PROFILES_DISABLED');
    const bundle = await saveContextBundle({
      workspaceId, bundleId, name: body.name, description: body.description || '',
      enabled: body.enabled !== false,
      entries,
      dependencies,
      maxDependencyDepth: policy.ccs.maxDependencyDepth
    });
    return { bundle };
  }
  if (req.method === 'DELETE' && bundleId) return { deleted: await deleteContextBundle(workspaceId, bundleId) };
  return null;
}


async function handlePresetMetadata(context) {
  const { req, parts, core, user } = context;
  if (parts[1] !== 'workspaces' || !parts[2] || parts[3] !== 'preset-metadata') return null;
  const workspaceId = parts[2];
  const requestUrl = new URL(req.url, 'http://orbitfs.local');
  const queryProjectId = String(requestUrl.searchParams.get('projectId') || '').trim() || null;
  if (req.method === 'GET') {
    try { await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_startup'); }
    catch { await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_preset_names'); }
    await ensureContextLibrarySchema();
    return { metadata: await getPresetMetadata(workspaceId, queryProjectId), projectId: queryProjectId };
  }
  await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_preset_names');
  await ensureContextLibrarySchema();
  if (req.method === 'PUT') {
    const body = await core.readBody(req);
    const projectId = String(body.projectId || queryProjectId || '').trim() || null;
    const metadata = await savePresetMetadata(workspaceId, body.metadata || {}, user?.id || null, projectId);
    return { metadata, projectId, changes: metadata._changes || [] };
  }
  return null;
}
async function handleDefaultProfiles(context) {
  const { req, parts, core } = context;
  if (parts[1] !== 'workspaces' || !parts[2] || parts[3] !== 'default-profiles') return null;
  const workspaceId = parts[2];
  await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_startup');
  await ensureContextLibrarySchema();
  if (req.method === 'GET') return await getDefaultProfileSelections(workspaceId);
  if (req.method === 'PUT') {
    const body = await core.readBody(req);
    return await saveDefaultProfileSelections(workspaceId, body.profileIds || [], body.profileBundleIds || []);
  }
  return null;
}

async function handleContextAssignments(context) {
  const { req, parts, core } = context;
  if (parts[1] !== 'workspaces' || !parts[2]) return null;
  const workspaceId = parts[2];
  const policy = effectivePolicy(await getAdminPolicy(), workspaceId);
  if (parts[3] === 'preset-bundles') {
    await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_startup');
    if (!policy.oss.enabled) throw policyError('OrbitFS Startup System is disabled for this workspace', 'OSS_DISABLED');
    await ensureContextLibrarySchema();
    const requestUrl = new URL(req.url, 'http://orbitfs.local');
    const queryProjectId = String(requestUrl.searchParams.get('projectId') || '').trim() || null;
    if (req.method === 'GET') return { assignments: await getPresetBundleAssignments(workspaceId, queryProjectId), projectId: queryProjectId };
    if (req.method === 'PUT') {
      const body = await core.readBody(req);
      const projectId = String(body.projectId || queryProjectId || '').trim() || null;
      for (const [preset, assignments] of Object.entries(body.assignments || {})) {
        if (!policy.oss.allowedStrengths.includes(preset) && Array.isArray(assignments) && assignments.length) throw policyError(`Preset ${preset} is disabled by MCP Admin policy`, 'OSS_STRENGTH_DISABLED');
        if (Array.isArray(assignments) && assignments.length > policy.oss.maxBundlesPerPreset) throw policyError(`Preset bundle limit is ${policy.oss.maxBundlesPerPreset}`, 'OSS_ASSIGNMENT_LIMIT');
      }
      return { assignments: await savePresetBundleAssignments(workspaceId, body.assignments || {}, projectId), projectId };
    }
  }
  if (parts[3] === 'projects' && parts[4] && parts[5] === 'context-bundles') {
    await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_projects');
    await ensureContextLibrarySchema();
    if (req.method === 'GET') return { assignments: await getProjectBundleAssignments(workspaceId, parts[4]) };
    if (req.method === 'PUT') {
      const body = await core.readBody(req);
      return { assignments: await saveProjectBundleAssignments(workspaceId, parts[4], Array.isArray(body.assignments) ? body.assignments : []) };
    }
  }
  return null;
}

async function engineRequest(context, endpoint, method = 'GET', body = undefined) {
  const addon = context.core.registry?.getAddon ? await context.core.registry.getAddon('mcp') : {};
  const storedConfig = await readAddonConfig();
  const config = { ...storedConfig, ...(addon?.config || {}) };
  const port = Number(config.port || 3939);
  const token = String(config.controlToken || '');
  if (!token) throw Object.assign(new Error('MCP control token is unavailable'), { status: 503, code: 'MCP_CONTROL_UNAVAILABLE' });
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `MCP engine returned ${response.status}`), { status: response.status, code: payload.code || 'MCP_ENGINE_ERROR' });
  return payload;
}

async function handleWorkspaceSetup(context) {
  const { req, parts, core } = context;
  if (parts[1] !== 'workspaces' || !parts[2] || parts[3] !== 'setup') return null;
  const workspaceId = parts[2];
  await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_settings');
  if (req.method === 'GET') return { config: await readMcpWorkspaceConfig(workspaceId) };
  if (req.method === 'PUT') {
    const body = await core.readBody(req);
    return { config: await saveMcpWorkspaceConfig(workspaceId, body || {}) };
  }
  return null;
}

async function handleClientRegistry(context) {
  const { req, parts, core, user } = context;
  if (parts[1] !== 'registry') return null;
  if (!['owner', 'admin'].includes(String(user?.role || '').toLowerCase())) {
    throw Object.assign(new Error('System administrator access required'), { status: 403, code: 'SYSTEM_ADMIN_REQUIRED' });
  }
  if (req.method === 'GET' && !parts[2]) return engineRequest(context, '/control/registry');
  if (parts[2] === 'clients' && parts[3]) {
    if (req.method === 'PATCH' && !parts[4]) return engineRequest(context, `/control/registry/clients/${encodeURIComponent(parts[3])}`, 'PATCH', await core.readBody(req));
    if (req.method === 'POST' && parts[4] === 'disconnect') return engineRequest(context, `/control/registry/clients/${encodeURIComponent(parts[3])}/disconnect`, 'POST', await core.readBody(req));
  }
  if (parts[2] === 'sessions' && parts[3] && req.method === 'POST' && parts[4] === 'disconnect') {
    return engineRequest(context, `/control/registry/sessions/${encodeURIComponent(parts[3])}/disconnect`, 'POST', await core.readBody(req));
  }
  return null;
}

async function handleAdminPolicy(context) {
  const { req, parts, core, user } = context;
  if (parts[1] !== 'admin-policy') return null;
  requireSystemAdmin(user);
  if (req.method === 'GET') return { policy: await getAdminPolicy() };
  if (req.method === 'PUT') {
    const body = await core.readBody(req);
    const policy = await saveAdminPolicy(body.policy || body);
    await engineRequest(context, '/control/policy', 'PUT', { policy }).catch((error) => {
      if (error?.status !== 404) throw error;
    });
    return { policy, applied: true };
  }
  return null;
}

async function handleActiveContext(context) {
  const { req, parts, core } = context;
  if (parts[1] !== 'workspaces' || !parts[2] || parts[3] !== 'active-context') return null;
  const workspaceId = parts[2];
  await requireWorkspaceCapability(context, workspaceId, 'manage_mcp_startup');
  if (req.method === 'GET' && !parts[4]) return engineRequest(context, `/control/context/${encodeURIComponent(workspaceId)}`);
  if (req.method === 'DELETE' && !parts[4]) return engineRequest(context, `/control/context/${encodeURIComponent(workspaceId)}`, 'DELETE');
  if (req.method === 'POST' && parts[4] === 'reload-changed') {
    const body = await core.readBody(req);
    return engineRequest(context, `/control/context/${encodeURIComponent(workspaceId)}/reload-changed`, 'POST', body || {});
  }
  if (req.method === 'POST' && parts[4] === 'remove-file') {
    const body = await core.readBody(req);
    return engineRequest(context, `/control/context/${encodeURIComponent(workspaceId)}/file`, 'DELETE', body || {});
  }
  if (req.method === 'POST' && parts[4] === 'load-file') {
    const body = await core.readBody(req);
    return engineRequest(context, `/control/context/${encodeURIComponent(workspaceId)}/load-file`, 'POST', body || {});
  }
  if (req.method === 'POST' && parts[4] === 'load-folder') {
    const body = await core.readBody(req);
    return engineRequest(context, `/control/context/${encodeURIComponent(workspaceId)}/load-folder`, 'POST', body || {});
  }
  return null;
}

async function handleRuntimeControl(context) {
  const { req, parts, core, user } = context;
  if (parts[1] !== 'runtime' || parts[2] !== 'control-token') return null;
  if (!['owner', 'admin'].includes(String(user?.role || '').toLowerCase())) {
    throw Object.assign(new Error('System administrator access required'), { status: 403, code: 'SYSTEM_ADMIN_REQUIRED' });
  }
  const config = await readAddonConfig();
  if (req.method === 'GET') return { configured: Boolean(config.controlToken), serviceName: 'OrbitFSMcpServer' };
  if (req.method === 'PUT') {
    const body = await core.readBody(req);
    const token = body.generate === true ? crypto.randomBytes(48).toString('base64url') : String(body.token || '').trim();
    if (token.length < 32) throw Object.assign(new Error('Control token must be at least 32 characters'), { status: 400, code: 'CONTROL_TOKEN_TOO_SHORT' });
    await saveControlToken(token);
    return { configured: true, restarted: true, serviceName: 'OrbitFSMcpServer' };
  }
  return null;
}

export async function handleRoute(context) {
  const { req, parts, user } = context;
  const mode = resolveMode(context);
  if (parts[0] !== 'mcp') return { __addonUnhandled: true };
  await context.core.requireComponent('orbitfs_mcp', 'MCP add-on');
  const runtimeControlResult = await handleRuntimeControl(context);
  if (runtimeControlResult) return runtimeControlResult;
  const adminPolicyResult = await handleAdminPolicy(context);
  if (adminPolicyResult) return adminPolicyResult;
  const workspaceSetupResult = await handleWorkspaceSetup(context);
  if (workspaceSetupResult) return workspaceSetupResult;
  const libraryResult = await handleContextLibrary(context);
  if (libraryResult) return libraryResult;
  const presetMetadataResult = await handlePresetMetadata(context);
  if (presetMetadataResult) return presetMetadataResult;
  const defaultProfilesResult = await handleDefaultProfiles(context);
  if (defaultProfilesResult) return defaultProfilesResult;
  const assignmentResult = await handleContextAssignments(context);
  if (assignmentResult) return assignmentResult;
  const activeContextResult = await handleActiveContext(context);
  if (activeContextResult) return activeContextResult;
  const registryResult = await handleClientRegistry(context);
  if (registryResult) return registryResult;
  if (req.method === 'GET' && parts[1] === 'mode') return mode;
  if (req.method === 'GET' && parts[1] === 'runtime') {
    const addon = context.core.registry?.getAddon ? await context.core.registry.getAddon('mcp') : {};
    const storedConfig = await readAddonConfig();
    const runtimeConfig = { ...storedConfig, ...(addon?.config || {}) };
    const health = context.core.services?.status ? await context.core.services.status('OrbitFSMcpServer') : {};
    const engine = await engineRequest(context, '/control/status').catch(() => null);
    const publicBaseUrl = String(runtimeConfig.publicBaseUrl || 'https://mcp.orbitfs.cc/mcp').replace(/\/$/, '');
    return {
      online: Boolean(health?.online ?? addon?.online), mode: mode.mode,
      workspaceIntegration: mode.mode === 'workspace', serviceName: 'OrbitFSMcpServer',
      port: Number(runtimeConfig.port || 3939), connectorPath: '/mcp', controlTokenConfigured: Boolean(runtimeConfig.controlToken),
      licensed: Boolean(addon?.licensed ?? true), attached: Boolean(addon?.attached ?? true), publicBaseUrl, health,
      appUi: engine?.appUi || null, oauth: engine?.oauth || null
    };
  }
  if (req.method === 'GET' && parts[1] === 'connection') return context.core.connector.describe('mcp', { mode, user });
  if (req.method === 'POST' && parts[1] === 'connection') return context.core.connector.begin('mcp', { mode, user, body: await context.core.readBody(req) });
  // Legacy workspace startup/project/preset routes are still implemented by the
  // panel backend. Returning unhandled lets its normal MCP route chain serve
  // them without coupling this removable add-on to a private core handler.
  return { __addonUnhandled: true };
}

export default { handleRoute };


