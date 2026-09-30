import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, '.orbitfs-config.json');

export const DEFAULT_POLICY = Object.freeze({
  oss: {
    enabled: true, allowedStrengths: ['low','medium','high','custom1','custom2'],
    allowCustomNames: true, maxPresetNameLength: 40, maxBundlesPerPreset: 20,
    maxFilesPerStartup: 100, maxCharactersPerStartup: 1500000,
    maxLoadSeconds: 30, defaultStrength: 'medium'
  },
  ccs: {
    enabled: true, maxBundlesPerWorkspace: 100, maxEntriesPerBundle: 100,
    maxDependenciesPerBundle: 10, maxDependencyDepth: 5,
    maxFileBytes: 20971520, maxDocumentFileBytes: 20971520,
    maxMediaFileBytes: 262144000, maxMediaOutputBytes: 12582912,
    maxBundleCharacters: 1500000, maxFolderDepth: 10, allowProfiles: true
  },
  registry: {
    maxActiveSessionsPerClient: 10, sessionIdleMinutes: 60,
    recentConnectionDays: 30, historyRetentionDays: 90
  },
  workspaceOverrides: {}
});

async function readConfig() {
  try { return JSON.parse(await readFile(configPath, 'utf8')); }
  catch { return {}; }
}
function integer(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export function normalizePolicy(input = {}) {
  const source = input || {}, defaults = DEFAULT_POLICY;
  const allowed = Array.isArray(source.oss?.allowedStrengths)
    ? source.oss.allowedStrengths.filter((v) => ['low','medium','high','custom1','custom2'].includes(v))
    : defaults.oss.allowedStrengths;
  return {
    oss: {
      enabled: source.oss?.enabled !== false,
      allowedStrengths: allowed.length ? [...new Set(allowed)] : defaults.oss.allowedStrengths,
      allowCustomNames: source.oss?.allowCustomNames !== false,
      maxPresetNameLength: integer(source.oss?.maxPresetNameLength, 40, 1, 80),
      maxBundlesPerPreset: integer(source.oss?.maxBundlesPerPreset, 20, 1, 500),
      maxFilesPerStartup: integer(source.oss?.maxFilesPerStartup, 100, 1, 10000),
      maxCharactersPerStartup: integer(source.oss?.maxCharactersPerStartup, 1500000, 1000, 100000000),
      maxLoadSeconds: integer(source.oss?.maxLoadSeconds, 30, 1, 600),
      defaultStrength: allowed.includes(source.oss?.defaultStrength) ? source.oss.defaultStrength : 'medium'
    },
    ccs: {
      enabled: source.ccs?.enabled !== false,
      maxBundlesPerWorkspace: integer(source.ccs?.maxBundlesPerWorkspace, 100, 1, 10000),
      maxEntriesPerBundle: integer(source.ccs?.maxEntriesPerBundle, 100, 1, 10000),
      maxDependenciesPerBundle: integer(source.ccs?.maxDependenciesPerBundle, 10, 0, 1000),
      maxDependencyDepth: integer(source.ccs?.maxDependencyDepth, 5, 1, 100),
      maxFileBytes: integer(source.ccs?.maxDocumentFileBytes ?? source.ccs?.maxFileBytes, 20971520, 1048576, 104857600),
      maxDocumentFileBytes: integer(source.ccs?.maxDocumentFileBytes ?? source.ccs?.maxFileBytes, 20971520, 1048576, 104857600),
      maxMediaFileBytes: integer(source.ccs?.maxMediaFileBytes, 262144000, 10485760, 1073741824),
      maxMediaOutputBytes: integer(source.ccs?.maxMediaOutputBytes, 12582912, 1048576, 52428800),
      maxBundleCharacters: integer(source.ccs?.maxBundleCharacters, 1500000, 1000, 100000000),
      maxFolderDepth: integer(source.ccs?.maxFolderDepth, 10, 1, 100),
      allowProfiles: source.ccs?.allowProfiles !== false
    },
    registry: {
      maxActiveSessionsPerClient: integer(source.registry?.maxActiveSessionsPerClient, 10, 1, 1000),
      sessionIdleMinutes: integer(source.registry?.sessionIdleMinutes, 60, 1, 43200),
      recentConnectionDays: integer(source.registry?.recentConnectionDays, 30, 1, 3650),
      historyRetentionDays: integer(source.registry?.historyRetentionDays, 90, 1, 3650)
    },
    workspaceOverrides: typeof source.workspaceOverrides === 'object' && source.workspaceOverrides
      ? source.workspaceOverrides : {}
  };
}

export async function getAdminPolicy() {
  const config = await readConfig();
  return normalizePolicy(config.adminPolicy);
}
export async function saveAdminPolicy(policy) {
  const config = await readConfig();
  const normalized = normalizePolicy(policy);
  config.adminPolicy = normalized;
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return normalized;
}

export function effectivePolicy(policy, workspaceId) {
  const override = policy.workspaceOverrides?.[workspaceId] || {};
  const overrideCcs = override.ccs || {};
  const ccs = { ...policy.ccs, ...overrideCcs };
  if (overrideCcs.maxDocumentFileBytes === undefined && overrideCcs.maxFileBytes !== undefined) {
    ccs.maxDocumentFileBytes = overrideCcs.maxFileBytes;
    ccs.maxFileBytes = overrideCcs.maxFileBytes;
  }
  return normalizePolicy({
    ...policy,
    oss: { ...policy.oss, ...(override.oss || {}) },
    ccs,
    registry: { ...policy.registry, ...(override.registry || {}) },
    workspaceOverrides: policy.workspaceOverrides
  });
}

export function policyError(message, code = 'MCP_POLICY_LIMIT') {
  return Object.assign(new Error(message), { status: 409, code });
}

export function requireSystemAdmin(user) {
  if (!['owner','admin'].includes(String(user?.role || '').toLowerCase())) {
    throw Object.assign(new Error('System administrator access required'), {
      status: 403, code: 'SYSTEM_ADMIN_REQUIRED'
    });
  }
}
