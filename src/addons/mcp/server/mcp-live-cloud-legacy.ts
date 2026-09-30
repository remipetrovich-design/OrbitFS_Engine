import crypto from 'node:crypto';
import path from 'node:path';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { workspaceRole } from '$lib/server/workspaces';
import {
  normalizePath, findEntry, listEntries, readEntryBytes, writeFileBytes,
  createFolder as createCloudFolder, moveEntry as moveCloudEntry, purgeEntry,
  requireCapability, storagePath, protectedWorkspacePath
} from '$lib/server/base-compat';
import {
  profileCatalog, profileKnowledgeProjection, profileMarkdown, exportProfileState,
  importProfileState, createProfile, updateProfile, deleteProfile, repairProfileState,
  createProfileCommandRequest
} from '$lib/server/workspace-profiles.js';
import {
  presentLibrary, readLibrary, retrieveLibrary, resolveLibraryRoleTargets
} from '$lib/server/library';
import {
  getStartup, getPresets, getPresetMetadata, getPresetBundles, listMcpProjects,
  projectBundleAssignments, listContextBundles, getContextBundle
} from '$lib/server/mcp-workspace-state';
import { buildMcpKnowledgeContext, knowledgeVersion } from './mcp-knowledge-context';
import type { OrbitUser } from '$lib/server/auth';

const PRESET_CAPS: Record<string, number> = {
  low: 500000, medium: 1500000, high: 5000000, custom1: 2000000, custom2: 2000000
};
const TEXT_EXTS = new Set(['.txt','.md','.markdown','.json','.jsonl','.yaml','.yml','.xml','.csv','.tsv','.js','.mjs','.cjs','.ts','.tsx','.jsx','.svelte','.html','.css','.scss','.sql','.py','.ps1','.bat','.cmd','.log','.ini','.toml','.env']);
const UI_CONTEXT_TOOLS = new Set(['orbitfs','orbitfs_ui_state','refresh_ui']);
const now = () => new Date().toISOString();
const clean = (value: unknown) => normalizePath(String(value ?? '')).replace(/^\/+|\/+$/g, '');
const hash = (buffer: Uint8Array) => crypto.createHash('sha256').update(buffer).digest('hex');
const err = (message: string, status = 400, code = 'MCP_ERROR', details?: any) =>
  Object.assign(new Error(message), { status, code, details });

export type CloudMcpIdentity = {
  user: OrbitUser;
  userId: string;
  username: string;
  role: string;
  scopes: Set<string>;
  clientId: string;
  clientName?: string;
  clientPermissions: { read: boolean; write: boolean };
  workspaceIds: string[];
  clientWorkspaceIds: string[];
  workspaceSnapshot: any[];
  currentWorkspaceId: string | null;
  persistedWorkspaceId: string | null;
  contextKey: string;
  conversationId: string;
  sessionId: string | null;
  uiContextOnly: boolean;
  contextCache: Map<string, any>;
};

async function requestBody(request: Request) {
  const cached = (request as any).__orbitfsParsedBody;
  if (cached && typeof cached === 'object') return cached;
  const body = await request.clone().json().catch(() => ({}));
  try { (request as any).__orbitfsParsedBody = body; } catch {}
  return body;
}

export async function createCloudMcpIdentity(
  request: Request,
  user: OrbitUser,
  scopes: Set<string>,
  token: any
): Promise<CloudMcpIdentity> {
  const db = getSupabaseAdmin();
  const clientId = String(token?.client_id || 'chatgpt');
  const body = await requestBody(request);
  const meta = body?.params?._meta || body?._meta || {};
  const toolName = String(body?.params?.name || '');
  const conversationId = String(
    request.headers.get('x-openai-conversation-id') ||
    request.headers.get('openai-conversation-id') ||
    request.headers.get('chatgpt-conversation-id') ||
    meta?.['openai/conversationId'] ||
    meta?.conversationId ||
    request.headers.get('mcp-session-id') ||
    'client'
  );
  const contextKey = `${String(user.id)}:${clientId}:${conversationId}`;

  const { data: client } = await db.from('mcp_clients').select('*').eq('id', clientId).maybeSingle();
  if (client && ['blocked', 'revoked'].includes(String(client.status))) {
    throw err(`MCP client is ${client.status}`, 403, 'CLIENT_ACCESS_REVOKED');
  }
  const permissions = client?.permissions || {};
  const clientPermissions = {
    read: permissions.read !== false,
    write: permissions.write !== false
  };
  if (!clientPermissions.read) throw err('MCP client read permission is disabled', 403, 'CLIENT_READ_DISABLED');

  const clientWorkspaceIds = Array.isArray(client?.workspace_ids) ? client.workspace_ids.map(String).filter(Boolean) : [];
  const workspaces = await accessibleMcpWorkspaces(user, false, clientWorkspaceIds);
  const workspaceIds = workspaces.map((w: any) => String(w.id));
  const identity: CloudMcpIdentity = {
    user,
    userId: String(user.id),
    username: String(user.username || ''),
    role: String(user.role || 'user').toLowerCase(),
    scopes,
    clientId,
    clientName: client?.client_name || undefined,
    clientPermissions,
    workspaceIds,
    clientWorkspaceIds,
    workspaceSnapshot: workspaces,
    currentWorkspaceId: workspaceIds[0] || null,
    persistedWorkspaceId: null,
    contextKey,
    conversationId,
    sessionId: null,
    uiContextOnly: UI_CONTEXT_TOOLS.has(toolName),
    contextCache: new Map()
  };
  const session = await touchCloudSession(identity);
  identity.sessionId = session.id;
  if (session.workspaceId && identity.workspaceIds.includes(session.workspaceId)) identity.currentWorkspaceId = session.workspaceId;
  identity.persistedWorkspaceId = session.workspaceId;
  return identity;
}

export function requireWrite(identity: CloudMcpIdentity) {
  if (!identity.scopes.has('orbitfs:write')) throw err('OAuth scope orbitfs:write is required', 403, 'WRITE_SCOPE_REQUIRED');
  if (identity.clientPermissions.write === false) throw err('Write access is disabled for this MCP client', 403, 'CLIENT_WRITE_DISABLED');
}

const MCP_WORKSPACE_CACHE_TTL_MS = 10000;
const mcpWorkspaceCache = new Map<string, { expiresAt: number; rows: any[] }>();

export async function accessibleMcpWorkspaces(user: OrbitUser, force = false, clientWorkspaceIds: string[] = []) {
  const grantedIds = [...new Set((clientWorkspaceIds || []).map(String).filter(Boolean))].sort();
  const cacheKey = `${String(user.id)}:${grantedIds.join(',') || '*'}`;
  const cached = mcpWorkspaceCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.rows;

  const db = getSupabaseAdmin();
  let workspaceQuery = db.from('orbitfs_workspaces')
    .select('id,name,status,visibility,is_main,owner_id,created_by,mcp_ui_enabled,mcp_system_enabled')
    .neq('status', 'archived')
    .order('is_main', { ascending: false })
    .order('name');
  if (grantedIds.length) workspaceQuery = workspaceQuery.in('id', grantedIds);

  const [workspaceResult, membershipResult] = await Promise.all([
    workspaceQuery,
    db.from('orbitfs_workspace_members').select('workspace_id,role,mcp_enabled').eq('user_id', user.id)
  ]);
  if (workspaceResult.error) throw workspaceResult.error;
  if (membershipResult.error) throw membershipResult.error;

  const systemRole = String(user.role || 'user').toLowerCase();
  const memberships = new Map((membershipResult.data || []).map((row: any) => [String(row.workspace_id), row]));
  const visible = (workspaceResult.data || []).flatMap((workspace: any) => {
    if (workspace.mcp_system_enabled === false) return [];
    const membership: any = memberships.get(String(workspace.id));
    if (membership?.mcp_enabled === false) return [];
    const ownsWorkspace = String(workspace.owner_id || workspace.created_by || '') === String(user.id);
    const systemAdmin = systemRole === 'owner' || systemRole === 'admin';
    const memberAllowed = membership?.mcp_enabled === true;
    if (!ownsWorkspace && !systemAdmin && !memberAllowed) return [];
    const permission = ownsWorkspace || systemAdmin ? 'owner' : String(membership?.role || 'viewer');
    return [{ ...workspace, permission, management_permissions: { mcp_use: true } }];
  });
  mcpWorkspaceCache.set(cacheKey, { expiresAt: Date.now() + MCP_WORKSPACE_CACHE_TTL_MS, rows: visible });
  return visible;
}

export async function chooseWorkspace(identity: CloudMcpIdentity, requested?: string | null) {
  const rows: any[] = identity.workspaceSnapshot?.length ? identity.workspaceSnapshot : await accessibleMcpWorkspaces(identity.user);
  const q = String(requested || identity.currentWorkspaceId || '').trim().toLowerCase();
  let selected: any = null;
  if (q) {
    const n = Number(q);
    if (Number.isInteger(n) && n >= 1 && n <= rows.length) selected = rows[n - 1];
    if (!selected) selected = rows.find((w: any) => String(w.id).toLowerCase() === q || String(w.name).toLowerCase() === q);
    if (!selected) {
      const matches = rows.filter((w: any) => String(w.id).toLowerCase().includes(q) || String(w.name).toLowerCase().includes(q));
      if (matches.length === 1) selected = matches[0];
      else if (matches.length > 1) return { matches };
    }
  }
  if (!selected) selected = rows.find((w: any) => w.mcp_ui_enabled !== false && String(w.status || '').toLowerCase() === 'active') || rows.find((w: any) => w.mcp_ui_enabled !== false) || rows.find((w: any) => String(w.status || '').toLowerCase() === 'active') || rows[0];
  if (!selected) throw err('No accessible workspace', 404, 'WORKSPACE_NOT_FOUND');
  const selectedId = String(selected.id);
  identity.currentWorkspaceId = selectedId;
  identity.workspaceIds = rows.map((w: any) => String(w.id));
  if (identity.sessionId && identity.persistedWorkspaceId !== selectedId) {
    const db = getSupabaseAdmin();
    const result = await db.rpc('orbitfs_set_mcp_session_workspace', { p_session_id: identity.sessionId, p_workspace_id: selectedId });
    if (result.error) throw result.error;
    identity.persistedWorkspaceId = selectedId;
  }
  return { workspace: selected, workspaces: rows };
}

async function touchCloudSession(identity: CloudMcpIdentity) {
  const db = getSupabaseAdmin();
  const result = await db.rpc('orbitfs_touch_mcp_session', {
    p_user_id: identity.userId,
    p_client_id: identity.clientId,
    p_username: identity.username,
    p_workspace_id: identity.currentWorkspaceId,
    p_context_key: identity.contextKey,
    p_conversation_id: identity.conversationId
  });
  if (result.error) throw result.error;
  const data = result.data && typeof result.data === 'object' ? result.data as Record<string, any> : {};
  return { id: String(data.id || ''), workspaceId: data.workspaceId ? String(data.workspaceId) : null };
}

function contextItemKey(item: any) {
  if (item.knowledgeItemId) return `knowledge:${item.knowledgeItemId}`;
  if (item.profileId) return `profile:${item.profileId}`;
  return `path:${clean(item.path).toLowerCase()}`;
}

function normalizeContextItem(item: any) {
  const owners = Array.from(new Set([
    ...(Array.isArray(item.contextOwners) ? item.contextOwners : []),
    ...(item.owner ? [item.owner] : []),
    ...(item.bundleId ? [`bundle:${item.bundleId}`] : []),
    ...(item.source ? [`source:${item.source}`] : [])
  ].filter(Boolean).map(String)));
  const content = typeof item.content === 'string' ? item.content : '';
  return {
    ...item,
    path: clean(item.path || ''),
    contextOwners: owners,
    characters: Number(item.characters ?? content.length ?? 0),
    opened: item.opened !== false,
    extracted: item.extracted !== false,
    transferred: item.transferred !== false,
    status: item.status || 'loaded'
  };
}

function mergeContextItems(a: any, b: any) {
  const left = normalizeContextItem(a);
  const right = normalizeContextItem(b);
  return {
    ...left,
    ...right,
    contextOwners: Array.from(new Set([...(left.contextOwners || []), ...(right.contextOwners || [])])),
    required: Boolean(left.required || right.required),
    defaultLoaded: Boolean(left.defaultLoaded || right.defaultLoaded)
  };
}

export async function getActiveContextUi(identity: CloudMcpIdentity, workspaceId: string) {
  await chooseWorkspace(identity, workspaceId);
  const db = getSupabaseAdmin();
  const result = await db.rpc('orbitfs_mcp_context_ui', {
    p_user_id: identity.userId,
    p_client_id: identity.clientId,
    p_workspace_id: workspaceId,
    p_context_key: identity.contextKey
  });
  if (result.error) throw result.error;
  return result.data || null;
}

export async function getActiveContext(identity: CloudMcpIdentity, workspaceId: string) {
  await chooseWorkspace(identity, workspaceId);
  if (identity.uiContextOnly) return getActiveContextUi(identity, workspaceId);
  if (identity.contextCache.has(workspaceId)) return identity.contextCache.get(workspaceId);
  const db = getSupabaseAdmin();
  const { data, error } = await db.from('mcp_active_contexts').select('receipt')
    .eq('user_id', identity.userId)
    .eq('client_id', identity.clientId)
    .eq('workspace_id', workspaceId)
    .eq('context_key', identity.contextKey)
    .maybeSingle();
  if (error) throw error;
  const receipt = data?.receipt || null;
  identity.contextCache.set(workspaceId, receipt);
  return receipt;
}

export async function saveActiveContext(identity: CloudMcpIdentity, workspaceId: string, receipt: any) {
  await chooseWorkspace(identity, workspaceId);
  const db = getSupabaseAdmin();
  const payload = {
    user_id: identity.userId,
    client_id: identity.clientId,
    workspace_id: workspaceId,
    context_key: identity.contextKey,
    receipt,
    updated_at: now()
  };
  const result = await db.from('mcp_active_contexts').upsert(payload, {
    onConflict: 'user_id,client_id,workspace_id,context_key'
  });
  if (result.error) throw result.error;
  identity.contextCache.set(workspaceId, receipt);
  return receipt;
}

export async function mergeActiveContext(identity: CloudMcpIdentity, workspaceId: string, patch: any) {
  const current = await getActiveContext(identity, workspaceId) || {
    contextId: `ctx-${crypto.randomUUID()}`, clientId: identity.clientId, workspaceId, files: [], errors: [], bundles: []
  };
  const byKey = new Map((current.files || []).map((item: any) => [contextItemKey(item), normalizeContextItem(item)]));
  for (const raw of patch.files || []) {
    const item = normalizeContextItem(raw);
    const key = contextItemKey(item);
    byKey.set(key, byKey.has(key) ? mergeContextItems(byKey.get(key), item) : item);
  }
  const files = [...byKey.values()];
  const receipt = {
    ...current,
    ...patch,
    contextId: patch.contextId || current.contextId || `ctx-${crypto.randomUUID()}`,
    clientId: identity.clientId,
    workspaceId,
    files,
    errors: [...(current.errors || []), ...(patch.errors || [])].slice(-250),
    transferredCount: files.filter((i: any) => i.transferred).length,
    openedCount: files.filter((i: any) => i.opened).length,
    extractedCount: files.filter((i: any) => i.extracted).length,
    charactersTransferred: files.reduce((sum: number, i: any) => sum + Number(i.characters || 0), 0),
    truncatedCount: files.filter((i: any) => i.truncated).length,
    completedAt: patch.completedAt || now()
  };
  return saveActiveContext(identity, workspaceId, receipt);
}

export async function clearActiveContext(identity: CloudMcpIdentity, workspaceId: string) {
  await chooseWorkspace(identity, workspaceId);
  const db = getSupabaseAdmin();
  const result = await db.from('mcp_active_contexts').delete()
    .eq('user_id', identity.userId).eq('client_id', identity.clientId)
    .eq('workspace_id', workspaceId).eq('context_key', identity.contextKey);
  if (result.error) throw result.error;
  identity.contextCache.delete(workspaceId);
  return null;
}

async function extractTextFromBytes(filePath: string, buffer: Buffer, maxCharacters: number) {
  const ext = path.extname(filePath).toLowerCase();
  let text = '';
  let kind = 'text';
  if (TEXT_EXTS.has(ext) || ext === '') {
    text = buffer.toString('utf8');
  } else if (ext === '.docx') {
    const mammoth = await import('mammoth');
    text = String((await mammoth.extractRawText({ buffer })).value || '');
    kind = 'docx';
  } else if (ext === '.pdf') {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages && pages.join('\n').length < maxCharacters; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item: any) => item.str || '').join(' '));
    }
    text = pages.join('\n\n');
    kind = 'pdf';
  } else {
    throw err(`Text extraction is not supported for ${ext || 'this file type'}`, 415, 'TEXT_EXTRACTION_UNSUPPORTED');
  }
  const fullCharacters = text.length;
  const content = text.slice(0, maxCharacters);
  return { content, kind, fullCharacters, characters: content.length, truncated: fullCharacters > content.length };
}

async function fileContextItem(identity: CloudMcpIdentity, workspaceId: string, filePath: string, maxCharacters: number, extras: any = {}) {
  const normalized = clean(filePath);
  await requireCapability(identity.user, workspaceId, normalized, 'read');
  const entry: any = await findEntry(workspaceId, normalized);
  if (!entry || entry.kind !== 'file') throw err('File not found', 404, 'FILE_NOT_FOUND');
  const raw = Buffer.from(await readEntryBytes(entry));
  const extracted = await extractTextFromBytes(normalized, raw, maxCharacters);
  return normalizeContextItem({
    path: normalized,
    source: extras.source || 'manual',
    content: extracted.content,
    characters: extracted.characters,
    fullCharacters: extracted.fullCharacters,
    truncated: extracted.truncated,
    documentKind: extracted.kind,
    bytes: raw.length,
    sha256: hash(raw),
    modifiedAt: entry.updated_at,
    ...extras
  });
}

async function folderFilePaths(workspaceId: string, folderPath: string, recursive = true, maxFiles = 100, maxDepth = 10) {
  const root = clean(folderPath);
  const db = getSupabaseAdmin();
  const { data, error } = await db.from('orbitfs_files').select('path,kind,updated_at')
    .eq('workspace_id', workspaceId).is('deleted_at', null).order('path').limit(5000);
  if (error) throw error;
  const prefix = root ? `${root}/` : '';
  const output: string[] = [];
  for (const row of data || []) {
    if (row.kind !== 'file') continue;
    const p = clean(row.path);
    if (root && !p.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const relative = root ? p.slice(prefix.length) : p;
    const depth = relative.split('/').filter(Boolean).length - 1;
    if ((!recursive && depth > 0) || depth > maxDepth) continue;
    if (p.toLowerCase().startsWith('_trash/')) continue;
    output.push(p);
    if (output.length >= maxFiles) break;
  }
  return output;
}

export async function loadFileIntoContext(identity: CloudMcpIdentity, workspaceId: string, filePath: string, maxCharacters = 500000, extras: any = {}) {
  await chooseWorkspace(identity, workspaceId);
  const item = await fileContextItem(identity, workspaceId, filePath, maxCharacters, extras);
  const receipt = await mergeActiveContext(identity, workspaceId, { files: [item], errors: [] });
  return { loaded: [item], errors: [], receipt, total: item.characters };
}

export async function loadFolderIntoContext(identity: CloudMcpIdentity, workspaceId: string, folderPath: string, maxFiles = 100, maxCharacters = 1500000, extras: any = {}) {
  await chooseWorkspace(identity, workspaceId);
  const normalized = clean(folderPath);
  if (normalized) {
    const folder: any = await findEntry(workspaceId, normalized);
    if (!folder || folder.kind !== 'folder') throw err('Folder not found', 404, 'FOLDER_NOT_FOUND');
    await requireCapability(identity.user, workspaceId, normalized, 'read');
  }
  const paths = await folderFilePaths(workspaceId, normalized, true, maxFiles, 10);
  const loaded: any[] = [], errors: any[] = [];
  let remaining = maxCharacters;
  for (const filePath of paths) {
    if (remaining <= 0 || loaded.length >= maxFiles) break;
    try {
      const item = await fileContextItem(identity, workspaceId, filePath, remaining, extras);
      loaded.push(item); remaining -= Number(item.characters || 0);
    } catch (error: any) {
      errors.push({ path: filePath, status: 'failed', code: error?.code || 'FILE_LOAD_FAILED', error: error?.message || String(error) });
    }
  }
  const receipt = await mergeActiveContext(identity, workspaceId, { files: loaded, errors });
  return { loaded, errors, receipt, total: loaded.reduce((n, i) => n + Number(i.characters || 0), 0), discoveredCount: paths.length };
}

async function profileContextItem(identity: CloudMcpIdentity, workspaceId: string, profileId: string, detail = 'standard', extras: any = {}, requiredPermission = 'view') {
  const role = await workspaceRole(identity.user, workspaceId);
  const result: any = await profileKnowledgeProjection(workspaceId, profileId, role, identity.userId, identity.role, requiredPermission);
  const profile = result.profile;
  let content = profileMarkdown(profile);
  if (detail === 'summary') content = content.slice(0, 12000);
  return normalizeContextItem({
    path: `Profiles/${profile.id}`,
    source: extras.source || 'profile',
    profileId: String(profile.id),
    profileName: profile.name,
    detail,
    content,
    characters: content.length,
    modifiedAt: profile.updatedAt || null,
    ...extras
  });
}

export async function listProfilesCloud(identity: CloudMcpIdentity, workspaceId: string) {
  await chooseWorkspace(identity, workspaceId);
  const role = await workspaceRole(identity.user, workspaceId);
  return profileCatalog(workspaceId, role, identity.userId, identity.role);
}

export async function viewProfileCloud(identity: CloudMcpIdentity, workspaceId: string, reference: string) {
  const catalog: any = await listProfilesCloud(identity, workspaceId);
  const q = String(reference || '').replace(/^Profiles\//i, '').trim().toLowerCase();
  let profile = (catalog.profiles || []).find((p: any) => String(p.id).toLowerCase() === q || String(p.name).toLowerCase() === q);
  if (!profile) {
    const matches = (catalog.profiles || []).filter((p: any) => String(p.name).toLowerCase().includes(q));
    if (matches.length === 1) profile = matches[0];
  }
  if (!profile) throw err('Profile not found or access denied', 404, 'PROFILE_NOT_FOUND');
  const item = await profileContextItem(identity, workspaceId, String(profile.id), 'standard');
  return { profile, content: item.content, item };
}

export async function loadProfileIntoContext(identity: CloudMcpIdentity, workspaceId: string, profileId: string, detail = 'standard', extras: any = {}) {
  await chooseWorkspace(identity, workspaceId);
  const item = await profileContextItem(identity, workspaceId, profileId, detail, extras, 'load_context');
  const receipt = await mergeActiveContext(identity, workspaceId, { files: [item], errors: [] });
  return { item, receipt };
}

function lifecycleWarning(item: any) {
  const state = String(item.effectiveLifecycleState || item.lifecycleState || item.lifecycle || '');
  if (state === 'old') return 'Historical/old Library source — may be outdated.';
  if (state === 'deprecated') return 'Deprecated Library source — use only when explicitly required.';
  if (state === 'archived') return 'Archived Library source — retained for historical context.';
  if (state === 'draft') return 'Draft Library source — not authoritative.';
  return '';
}

export async function loadKnowledgeCloud(identity: CloudMcpIdentity, workspaceId: string, itemId: string, maxCharacters = 500000, mode?: string, extras: any = {}) {
  await chooseWorkspace(identity, workspaceId);
  const state: any = await readLibrary(workspaceId);
  const item = (state.items || []).find((x: any) => String(x.id) === String(itemId));
  if (!item) throw err('Knowledge item not found', 404, 'KNOWLEDGE_ITEM_NOT_FOUND');
  const effectiveMode = mode || item.effectiveLoadMode || item.loadMode || 'full';
  let content = '';
  let contextMeta:any = null;
  const provider = String(item.source?.provider || '');
  if (provider === 'library.native' || provider === 'memory.knowledge') {
    contextMeta = buildMcpKnowledgeContext(state, item, maxCharacters, effectiveMode);
    content = contextMeta.content;
  } else if (provider === 'base.files') {
    throw err('Legacy file-backed Library items are compatibility-only and cannot be loaded as canonical knowledge.', 410, 'LIBRARY_FILE_PROVIDER_RETIRED');
  } else if (provider === 'base.profiles') {
    const profileId = String(item.source?.locator?.profileId || '');
    const profile = await profileContextItem(identity, workspaceId, profileId, 'standard', extras, 'load_context');
    content = profile.content;
  } else {
    const sections = (state.sections || []).filter((s: any) => String(s.itemId) === String(itemId));
    const raw = sections.map((s: any) => `## ${s.title || s.id}\n${s.content || ''}`).join('\n\n');
    const cap = effectiveMode === 'summary' ? Math.min(maxCharacters, 4000) : effectiveMode === 'smart' ? Math.min(maxCharacters, 24000) : maxCharacters;
    content = raw.slice(0, cap);
  }
  const contextItem = normalizeContextItem({
    path: `Library/${itemId}`,
    source: extras.source || 'knowledge',
    knowledgeItemId: String(itemId),
    knowledgeItemName: item.name || itemId,
    knowledgeVersion: contextMeta?.knowledgeVersion || knowledgeVersion(item),
    lifecycleState: item.effectiveLifecycleState || item.lifecycleState || item.lifecycle,
    libraryRoles: item.roles || [],
    loadMode: effectiveMode,
    knowledgeSelection: contextMeta?.selection || effectiveMode,
    selectedSectionIds: contextMeta?.selectedSectionIds || [],
    apex: contextMeta?.apex || item.metadata?.apex || null,
    provenance: contextMeta?.provenance || [],
    warning: lifecycleWarning(item),
    content,
    characters: content.length,
    fullCharacters: contextMeta?.fullCharacters ?? String(item.content || content).length,
    truncated: contextMeta?.truncated ?? String(item.content || content).length > content.length,
    modifiedAt: item.updatedAt || item.updated_at || null,
    ...extras
  });
  return { item, contextItem };
}

export async function loadKnowledgeIntoContext(identity: CloudMcpIdentity, workspaceId: string, itemId: string, maxCharacters = 500000, mode?: string, extras: any = {}) {
  const loaded = await loadKnowledgeCloud(identity, workspaceId, itemId, maxCharacters, mode, extras);
  const receipt = await mergeActiveContext(identity, workspaceId, { files: [loaded.contextItem], errors: [] });
  return { ...loaded, receipt };
}

async function resolveBundleTree(workspaceId: string, rootBundleId: string) {
  const visited = new Set<string>(), stack = new Set<string>(), bundles: any[] = [], entries: any[] = [];
  async function visit(bundleId: string) {
    if (stack.has(bundleId)) throw err('Context bundle dependency cycle detected', 409, 'CCS_DEPENDENCY_CYCLE');
    if (visited.has(bundleId)) return;
    stack.add(bundleId);
    const bundle: any = await getContextBundle(workspaceId, bundleId);
    for (const dep of bundle.dependencies || []) {
      try { await visit(String(dep.bundleId)); }
      catch (error) { if (dep.required !== false) throw error; }
    }
    stack.delete(bundleId); visited.add(bundleId);
    bundles.push(bundle);
    for (const raw of bundle.entries || []) entries.push({
      ...raw,
      bundleId: String(bundle.id),
      bundleName: bundle.name,
      required: raw.required !== false,
      priority: Number(raw.priority || 100)
    });
  }
  await visit(String(rootBundleId));
  return { rootBundleId: String(rootBundleId), bundles, entries };
}

export async function loadContextBundleCloud(identity: CloudMcpIdentity, workspaceId: string, bundleId: string, maxFiles = 250, maxCharacters = 1500000) {
  await chooseWorkspace(identity, workspaceId);
  const resolved = await resolveBundleTree(workspaceId, bundleId);
  const loaded: any[] = [], errors: any[] = [];
  let remaining = maxCharacters;
  for (const entry of resolved.entries.sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100))) {
    if (loaded.length >= maxFiles || remaining <= 0) break;
    try {
      if (entry.attachmentType === 'profile' && entry.profileId) {
        const item = await profileContextItem(identity, workspaceId, String(entry.profileId), 'standard', {
          source: 'profile', bundleId: entry.bundleId, bundleName: entry.bundleName, required: entry.required
        }, 'load_context');
        item.content = item.content.slice(0, remaining); item.characters = item.content.length;
        loaded.push(item); remaining -= item.characters;
      } else if (entry.attachmentType === 'knowledge' && entry.knowledgeItemId) {
        const result = await loadKnowledgeCloud(identity, workspaceId, String(entry.knowledgeItemId), remaining, entry.loadMode, {
          source: 'knowledge', bundleId: entry.bundleId, bundleName: entry.bundleName, required: entry.required
        });
        loaded.push(result.contextItem); remaining -= result.contextItem.characters;
      } else if ((entry.type || entry.entryType) === 'folder') {
        const paths = await folderFilePaths(workspaceId, String(entry.path || ''), entry.recursive !== false, Math.max(0, maxFiles - loaded.length), 10);
        for (const filePath of paths) {
          if (loaded.length >= maxFiles || remaining <= 0) break;
          const item = await fileContextItem(identity, workspaceId, filePath, remaining, {
            source: 'bundle', bundleId: entry.bundleId, bundleName: entry.bundleName, required: entry.required
          });
          loaded.push(item); remaining -= item.characters;
        }
      } else {
        const item = await fileContextItem(identity, workspaceId, String(entry.path || ''), remaining, {
          source: 'bundle', bundleId: entry.bundleId, bundleName: entry.bundleName, required: entry.required
        });
        loaded.push(item); remaining -= item.characters;
      }
    } catch (error: any) {
      const failure = { path: entry.path || `Library/${entry.knowledgeItemId || ''}` || `Profiles/${entry.profileId || ''}`, bundleId: entry.bundleId, required: entry.required, code: error?.code || 'CCS_ENTRY_LOAD_FAILED', error: error?.message || String(error) };
      errors.push(failure);
      if (entry.required) throw err(`Required bundle entry failed: ${failure.path}: ${failure.error}`, 409, 'BUNDLE_REQUIRED_ENTRY_FAILED', failure);
    }
  }
  let receipt = await mergeActiveContext(identity, workspaceId, { files: loaded, errors });
  const bundleLoad = {
    rootBundleId: String(bundleId),
    bundleIds: resolved.bundles.map((b: any) => String(b.id)),
    bundleNames: resolved.bundles.map((b: any) => b.name),
    loadedAt: now()
  };
  receipt = await saveActiveContext(identity, workspaceId, {
    ...receipt,
    bundles: [...(receipt.bundles || []).filter((x: any) => String(x.rootBundleId || x.id) !== String(bundleId)), bundleLoad]
  });
  return { resolved, loaded, errors, receipt };
}

export async function unloadContextBundleCloud(identity: CloudMcpIdentity, workspaceId: string, bundleId: string) {
  const current = await getActiveContext(identity, workspaceId);
  if (!current) return null;
  const target = (current.bundles || []).find((b: any) => String(b.rootBundleId || b.id || '') === String(bundleId));
  const removedIds = new Set((target?.bundleIds?.length ? target.bundleIds : [bundleId]).map(String));
  const remainingBundles = (current.bundles || []).filter((b: any) => String(b.rootBundleId || b.id || '') !== String(bundleId));
  const stillNeeded = new Set(remainingBundles.flatMap((b: any) => b.bundleIds || (b.id ? [b.id] : [])).map(String));
  const files: any[] = [];
  for (const raw of current.files || []) {
    const item = normalizeContextItem(raw);
    const owners = (item.contextOwners || []).filter((owner: string) => {
      if (!owner.startsWith('bundle:')) return true;
      const id = owner.slice(7);
      return !removedIds.has(id) || stillNeeded.has(id);
    });
    if (owners.length) files.push({ ...item, contextOwners: owners });
  }
  return saveActiveContext(identity, workspaceId, {
    ...current, bundles: remainingBundles, files,
    charactersTransferred: files.reduce((n: number, i: any) => n + Number(i.characters || 0), 0),
    transferredCount: files.length, completedAt: now()
  });
}

async function expandProfileBundleIds(identity: CloudMcpIdentity, workspaceId: string, bundleIds: string[]) {
  if (!bundleIds.length) return [];
  const catalog: any = await listProfilesCloud(identity, workspaceId);
  const byId = new Map((catalog.profileBundles || []).map((b: any) => [String(b.id), b]));
  const out: { profileId: string; bundleId: string; bundleName: string }[] = [];
  for (const id of bundleIds) {
    const bundle: any = byId.get(String(id));
    if (!bundle) continue;
    for (const profileId of bundle.profileIds || []) out.push({ profileId: String(profileId), bundleId: String(bundle.id), bundleName: bundle.name });
  }
  return out;
}

export async function runStartupCloud(identity: CloudMcpIdentity, workspaceId: string, strength: string, projectId?: string | null, defaultsOnly = false, maxFiles = 250, maxCharacters?: number) {
  await chooseWorkspace(identity, workspaceId);
  const startup: any = await getStartup(workspaceId);
  const preset = String(strength || startup.strength || 'medium');
  const charCap = Math.min(Number(maxCharacters || PRESET_CAPS[preset] || 1500000), PRESET_CAPS[preset] || 1500000, 5000000);
  const projects: any[] = await listMcpProjects(workspaceId);
  const chosenProject = projectId ? projects.find((p: any) => String(p.id) === String(projectId)) : projects.find((p: any) => (startup.projectIds || []).map(String).includes(String(p.id)));
  const presetScopeId = chosenProject?.id || null;
  const presets: any = await getPresets(workspaceId, presetScopeId);
  const presetMeta: any = await getPresetMetadata(workspaceId, presetScopeId);
  const presetBundles: any = await getPresetBundles(workspaceId, presetScopeId);
  const selectedPreset = presets[preset] || {};

  const items: any[] = [];
  for (const x of startup.defaultItems || []) items.push({ path: x.path, type: x.type || 'file', recursive: Boolean(x.recursive), source: 'default', defaultLoaded: true });
  if (!defaultsOnly && chosenProject) for (const x of chosenProject.items || []) items.push({ path: x.item_path || x.path, type: x.item_type || x.type || 'file', recursive: Boolean(x.recursive_flag ?? x.recursive), source: 'startup' });
  if (!defaultsOnly) for (const x of selectedPreset.items || []) items.push({ path: x.item_path || x.path, type: x.item_type || x.type || 'file', recursive: Boolean(x.recursive_flag ?? x.recursive), source: 'startup' });

  const profiles: any[] = [];
  for (const id of startup.defaultProfileIds || []) profiles.push({ profileId: String(id), source: 'default-profile', defaultLoaded: true });
  if (!defaultsOnly) for (const id of selectedPreset.profileIds || []) profiles.push({ profileId: String(id), source: 'preset-profile' });

  const defaultProfileBundles = await expandProfileBundleIds(identity, workspaceId, (startup.defaultProfileBundleIds || []).map(String));
  for (const item of defaultProfileBundles) profiles.push({ ...item, source: 'default-profile-bundle', defaultLoaded: true });
  if (!defaultsOnly) {
    const presetProfileBundles = await expandProfileBundleIds(identity, workspaceId, (selectedPreset.profileBundleIds || []).map(String));
    for (const item of presetProfileBundles) profiles.push({ ...item, source: 'preset-profile-bundle' });
  }

  const loaded: any[] = [], errors: any[] = [];
  let remaining = charCap;
  for (const entry of profiles) {
    if (loaded.length >= maxFiles || remaining <= 0) break;
    try {
      const item = await profileContextItem(identity, workspaceId, entry.profileId, 'standard', entry, 'load_context');
      item.content = item.content.slice(0, remaining); item.characters = item.content.length;
      loaded.push(item); remaining -= item.characters;
    } catch (error: any) {
      errors.push({ path: `Profiles/${entry.profileId}`, status: 'failed', error: error?.message || String(error), code: error?.code || 'PROFILE_LOAD_FAILED' });
    }
  }

  for (const entry of items) {
    if (loaded.length >= maxFiles || remaining <= 0) break;
    try {
      if (entry.type === 'folder') {
        const paths = await folderFilePaths(workspaceId, entry.path, entry.recursive !== false, Math.max(0, maxFiles - loaded.length), 10);
        for (const filePath of paths) {
          if (loaded.length >= maxFiles || remaining <= 0) break;
          const item = await fileContextItem(identity, workspaceId, filePath, remaining, entry);
          loaded.push(item); remaining -= item.characters;
        }
      } else {
        const item = await fileContextItem(identity, workspaceId, entry.path, remaining, entry);
        loaded.push(item); remaining -= item.characters;
      }
    } catch (error: any) {
      errors.push({ path: entry.path, status: 'failed', error: error?.message || String(error), code: error?.code || 'FILE_LOAD_FAILED' });
    }
  }

  let receipt: any = {
    contextId: `ctx-${crypto.randomUUID()}`,
    clientId: identity.clientId,
    workspaceId,
    preset, strength: preset,
    presetDisplayName: presetMeta?.[preset]?.displayName || preset,
    projectId: chosenProject?.id || null,
    projectName: chosenProject?.name || null,
    bundles: [],
    startedAt: now(),
    selectedCount: loaded.length + errors.length,
    files: loaded,
    errors,
    limitCharacters: charCap
  };

  if (!defaultsOnly) {
    const bundleIds: string[] = [];
    for (const assignment of presetBundles?.[preset] || []) bundleIds.push(String(assignment.bundleId));
    if (chosenProject) for (const assignment of await projectBundleAssignments(String(chosenProject.id))) bundleIds.push(String(assignment.bundleId));
    for (const id of Array.from(new Set(bundleIds))) {
      if (loaded.length >= maxFiles || remaining <= 0) break;
      try {
        await saveActiveContext(identity, workspaceId, receipt);
        const result = await loadContextBundleCloud(identity, workspaceId, id, Math.max(0, maxFiles - loaded.length), remaining);
        receipt = result.receipt;
        for (const item of result.loaded) loaded.push(item);
        for (const failure of result.errors) errors.push(failure);
        remaining = Math.max(0, charCap - loaded.reduce((n, i) => n + Number(i.characters || 0), 0));
      } catch (error: any) {
        errors.push({ path: `Bundle/${id}`, status: 'failed', error: error?.message || String(error), code: error?.code || 'BUNDLE_LOAD_FAILED' });
      }
    }
  }

  const files = [...new Map(loaded.map((item: any) => [contextItemKey(item), normalizeContextItem(item)])).values()];
  receipt = await saveActiveContext(identity, workspaceId, {
    ...receipt,
    files,
    errors,
    completedAt: now(),
    openedCount: files.length,
    extractedCount: files.length,
    transferredCount: files.length,
    failedCount: errors.length,
    charactersTransferred: files.reduce((n: number, i: any) => n + Number(i.characters || 0), 0),
    truncatedCount: files.filter((i: any) => i.truncated).length
  });
  return { config: { startup, project: chosenProject || null, presets, presetMetadata: presetMeta }, loaded: files, errors, receipt, total: receipt.charactersTransferred };
}

export function compactContext(receipt: any, changedFiles: any[] = []) {
  if (!receipt) return { state:'Empty', progress:'[----------] 0%', files:0, parsed:0, characters:0, charactersLabel:'0', bytes:0, bytesLabel:'0 B', changedFiles:0, items:[] };
  const files = Array.isArray(receipt.files) ? receipt.files : [];
  const parsed = files.filter((f: any) => f.opened || f.extracted || f.transferred).length;
  const total = files.length, pct = total ? Math.round(parsed / total * 100) : 100;
  const bars = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const characters = Number(receipt.charactersTransferred || files.reduce((n: number, f: any) => n + Number(f.characters || 0), 0));
  const bytes = files.reduce((n: number, f: any) => n + Number(f.bytes || 0), 0);
  const compactNumber = (n: number) => n >= 1000000 ? `${(n/1000000).toFixed(n>=10000000?0:1)}m` : n >= 1000 ? `${(n/1000).toFixed(n>=10000?0:1)}k` : String(n);
  const readableBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024**2 ? `${(n/1024).toFixed(1)} KB` : n < 1024**3 ? `${(n/1024**2).toFixed(1)} MB` : `${(n/1024**3).toFixed(1)} GB`;
  return {
    state: changedFiles.length ? 'Loaded - changes detected' : 'Ready',
    progress: `[${'#'.repeat(bars)}${'-'.repeat(10-bars)}] ${pct}%`,
    files: total, parsed, characters, charactersLabel: compactNumber(characters), bytes, bytesLabel: readableBytes(bytes),
    changedFiles: changedFiles.length,
    items: files.slice(0,8).map((f: any) => ({ path:f.path,status:f.status||'loaded',characters:Number(f.characters||0) })),
    moreItems: Math.max(0,total-8)
  };
}

export async function inspectContextChanges(identity: CloudMcpIdentity, workspaceId: string, receipt?: any) {
  const current = receipt || await getActiveContext(identity, workspaceId);
  if (!current?.files?.length) return { outdated:false, changedFiles:[] };
  const changedFiles: any[] = [];
  const library:any = (current.files || []).some((item:any)=>item.knowledgeItemId) ? await readLibrary(workspaceId).catch(()=>null) : null;
  for (const item of current.files) {
    if (item.knowledgeItemId) {
      const currentItem = (library?.items || []).find((entry:any)=>String(entry.id)===String(item.knowledgeItemId));
      if (!currentItem) {
        changedFiles.push({ path:`Library/${item.knowledgeItemId}`,knowledgeItemId:item.knowledgeItemId,status:'missing' });
        continue;
      }
      const lifecycle=String(currentItem.effectiveLifecycleState||currentItem.lifecycleState||currentItem.lifecycle||'');
      if (['old','deprecated','archived'].includes(lifecycle)) {
        changedFiles.push({ path:`Library/${item.knowledgeItemId}`,knowledgeItemId:item.knowledgeItemId,status:'superseded',lifecycleState:lifecycle });
        continue;
      }
      const loadedVersion=String(item.knowledgeVersion||item.modifiedAt||'');
      const currentVersion=knowledgeVersion(currentItem);
      if (loadedVersion!==currentVersion) changedFiles.push({ path:`Library/${item.knowledgeItemId}`,knowledgeItemId:item.knowledgeItemId,status:'modified',loadedVersion,currentVersion });
      continue;
    }
    if (item.source === 'profile' || item.profileId) continue;
    const entry: any = await findEntry(workspaceId, item.path).catch(() => null);
    if (!entry) { changedFiles.push({ path:item.path,status:'missing' }); continue; }
    if (String(entry.updated_at || '') !== String(item.modifiedAt || '')) changedFiles.push({ path:item.path,status:'modified',loadedModifiedAt:item.modifiedAt,currentModifiedAt:entry.updated_at });
  }
  return { outdated:changedFiles.length > 0, changedFiles };
}

export async function removeContextItem(identity: CloudMcpIdentity, workspaceId: string, targetPath: string) {
  const current = await getActiveContext(identity, workspaceId);
  if (!current) return null;
  const q = clean(targetPath).toLowerCase();
  const files = (current.files || []).filter((i: any) => clean(i.path).toLowerCase() !== q);
  return saveActiveContext(identity, workspaceId, {
    ...current, files,
    transferredCount: files.length,
    charactersTransferred: files.reduce((n: number, i: any) => n + Number(i.characters || 0), 0),
    completedAt: now()
  });
}

export async function reloadChangedContext(identity: CloudMcpIdentity, workspaceId: string, maxCharacters = 500000) {
  const current = await getActiveContext(identity, workspaceId);
  if (!current) return { receipt:null, loaded:[], errors:[] };
  const changes = await inspectContextChanges(identity, workspaceId, current);
  const loaded: any[] = [], errors: any[] = [];
  let remaining = maxCharacters;
  for (const change of changes.changedFiles) {
    if (change.status !== 'modified' || remaining <= 0) continue;
    const old = (current.files || []).find((i: any) => change.knowledgeItemId ? String(i.knowledgeItemId)===String(change.knowledgeItemId) : clean(i.path).toLowerCase() === clean(change.path).toLowerCase());
    try {
      if (change.knowledgeItemId) {
        const result=await loadKnowledgeCloud(identity,workspaceId,String(change.knowledgeItemId),remaining,old?.loadMode||'smart',{
          source:old?.source||'knowledge',contextOwners:old?.contextOwners||[],defaultLoaded:old?.defaultLoaded,bundleId:old?.bundleId,bundleName:old?.bundleName,required:old?.required
        });
        loaded.push(result.contextItem);remaining-=result.contextItem.characters;
      } else {
        const item = await fileContextItem(identity, workspaceId, change.path, remaining, {
          source: old?.source || 'manual', contextOwners: old?.contextOwners || [], defaultLoaded: old?.defaultLoaded,
          bundleId: old?.bundleId, bundleName: old?.bundleName
        });
        loaded.push(item); remaining -= item.characters;
      }
    } catch (error: any) {
      errors.push({ path:change.path,status:'failed',code:error?.code||'RELOAD_FAILED',error:error?.message||String(error) });
    }
  }
  const withoutChanged = (current.files || []).filter((i: any) => !changes.changedFiles.some((c: any) => c.status==='modified' && (c.knowledgeItemId ? String(i.knowledgeItemId)===String(c.knowledgeItemId) : clean(c.path).toLowerCase() === clean(i.path).toLowerCase())));
  const receipt = await saveActiveContext(identity, workspaceId, {
    ...current,
    files: [...withoutChanged, ...loaded],
    errors: [...(current.errors || []), ...errors],
    completedAt: now()
  });
  return { receipt, loaded, errors, changes };
}

export async function browseWorkspace(identity: CloudMcpIdentity, workspaceId: string, folderPath = '') {
  await chooseWorkspace(identity, workspaceId);
  await requireCapability(identity.user, workspaceId, clean(folderPath), 'read');
  const entries: any[] = await listEntries(workspaceId, clean(folderPath));
  const permitted: any[] = [];
  for (const entry of entries) {
    try { await requireCapability(identity.user, workspaceId, entry.path, 'read'); permitted.push(entry); } catch {}
  }
  return permitted;
}

export async function searchFilesCloud(identity: CloudMcpIdentity, workspaceId: string, query: string, basePath = '', includeContent = false, maxResults = 50) {
  await chooseWorkspace(identity, workspaceId);
  await requireCapability(identity.user, workspaceId, clean(basePath), 'read');
  const db = getSupabaseAdmin();
  const { data, error } = await db.from('orbitfs_files').select('*').eq('workspace_id', workspaceId).is('deleted_at', null).limit(5000);
  if (error) throw error;
  const q = String(query).toLowerCase();
  const prefix = clean(basePath).toLowerCase();
  const matches: any[] = [], failedFiles: any[] = [];
  for (const row of data || []) {
    const p = clean(row.path);
    if (prefix && p.toLowerCase() !== prefix && !p.toLowerCase().startsWith(prefix + '/')) continue;
    let score = 0, excerpt = '';
    if (String(row.name || '').toLowerCase().includes(q)) score += 5;
    if (p.toLowerCase().includes(q)) score += 3;
    if (includeContent && row.kind === 'file' && matches.length < maxResults) {
      try {
        await requireCapability(identity.user, workspaceId, p, 'read');
        const raw = Buffer.from(await readEntryBytes(row));
        if (raw.length <= 2_000_000) {
          const text = TEXT_EXTS.has(path.extname(p).toLowerCase()) ? raw.toString('utf8') : '';
          const index = text.toLowerCase().indexOf(q);
          if (index >= 0) { score += 2; excerpt = text.slice(Math.max(0,index-120), index+q.length+240); }
        }
      } catch (error: any) {
        failedFiles.push({ path:p,code:error?.code||'READ_FAILED',error:error?.message||String(error) });
      }
    }
    if (!score) continue;
    try {
      await requireCapability(identity.user, workspaceId, p, 'read');
      matches.push({ path:p,name:row.name,type:row.kind==='folder'?'dir':'file',bytes:row.size_bytes,modifiedAt:row.updated_at,score,excerpt });
    } catch (error: any) {
      failedFiles.push({ path:p,code:error?.code||'READ_PERMISSION_DENIED',error:error?.message||String(error) });
    }
  }
  matches.sort((a,b) => b.score-a.score || a.path.localeCompare(b.path));
  return { matches:matches.slice(0,maxResults), failedFiles, failedCount:failedFiles.length };
}

export async function readFileCloud(identity: CloudMcpIdentity, workspaceId: string, filePath: string, output = 'auto', maxCharacters = 500000, maxBytes = 20971520) {
  await chooseWorkspace(identity, workspaceId);
  const p = clean(filePath);
  await requireCapability(identity.user, workspaceId, p, 'read');
  const entry: any = await findEntry(workspaceId, p);
  if (!entry || entry.kind !== 'file') throw err('File not found',404,'FILE_NOT_FOUND');
  const raw = Buffer.from(await readEntryBytes(entry));
  if (raw.length > maxBytes) throw err(`File exceeds ${maxBytes} byte read limit`,413,'FILE_TOO_LARGE');
  const metadata = { path:p,bytes:raw.length,modifiedAt:entry.updated_at,mimeType:entry.mime_type||'application/octet-stream',sha256:hash(raw) };
  if (output !== 'base64') {
    try {
      const document = await extractTextFromBytes(p, raw, maxCharacters);
      return { encoding:'text',metadata,document,content:document.content };
    } catch (error) { if (output === 'text') throw error; }
  }
  return { encoding:'base64',metadata,data:raw.toString('base64') };
}

export async function writeFileCloud(identity: CloudMcpIdentity, workspaceId: string, filePath: string, data: string, options: any = {}) {
  requireWrite(identity);
  await chooseWorkspace(identity, workspaceId);
  const p = clean(filePath);
  if (!p || protectedWorkspacePath(p) || p.toLowerCase().startsWith('_trash/')) throw err('Protected OrbitFS system path',403,'PROTECTED_SYSTEM_PATH');
  const current: any = await findEntry(workspaceId,p).catch(()=>null);
  const mode = options.mode || 'create';
  if (current?.kind === 'folder') throw err('Path is a folder',409,'PATH_IS_FOLDER');
  await requireCapability(identity.user, workspaceId, p, current ? 'write' : 'create');
  if (mode === 'create' && current) throw err('File already exists',409,'FILE_EXISTS');
  if (mode === 'update' && !current) throw err('File not found',404,'FILE_NOT_FOUND');
  if (current && !options.expectedSha256) throw err('expectedSha256 is required when replacing an existing file',409,'OVERWRITE_CONFIRMATION_REQUIRED');
  if (current && options.expectedSha256) {
    const currentRaw = Buffer.from(await readEntryBytes(current));
    if (hash(currentRaw).toLowerCase() !== String(options.expectedSha256).toLowerCase()) throw err('File changed since it was read',409,'FILE_VERSION_CONFLICT');
  }
  let buffer: Buffer;
  if ((options.encoding || 'utf8') === 'base64') {
    if (options.fileTransferIntent !== 'orbitfs') throw err('Explicit OrbitFS file transfer intent is required for base64 data',400,'ORBITFS_FILE_TRANSFER_INTENT_REQUIRED');
    buffer = Buffer.from(String(data).replace(/\s/g,''),'base64');
    if (buffer.toString('base64').replace(/=+$/,'') !== String(data).replace(/\s/g,'').replace(/=+$/,'')) throw err('Invalid base64 data',400,'INVALID_BASE64');
  } else buffer = Buffer.from(String(data),'utf8');
  if (buffer.length > Number(options.maxBytes || 104857600)) throw err('File exceeds write limit',413,'FILE_TOO_LARGE');
  const saved: any = await writeFileBytes({ workspaceId, path:p, bytes:buffer, mimeType:options.mimeType || undefined, userId:identity.userId, preferText:(options.encoding || 'utf8') === 'utf8', upsert:Boolean(current) });
  return { created:!current,updated:Boolean(current),metadata:{path:p,bytes:buffer.length,modifiedAt:saved.updated_at,mimeType:saved.mime_type,sha256:hash(buffer),encoding:options.encoding||'utf8'} };
}

export async function uploadChatGptFileCloud(identity: CloudMcpIdentity, workspaceId: string, file: any, directory = '', fileName?: string, maxBytes = 104857600) {
  requireWrite(identity);
  if (!file?.download_url || !file?.file_id) throw err('ChatGPT file is required',400,'INVALID_FILE');
  const url = new URL(file.download_url);
  if (url.protocol !== 'https:') throw err('ChatGPT file download URL must use HTTPS',400,'INVALID_FILE_DOWNLOAD_URL');
  const response = await fetch(url,{redirect:'follow'});
  if (!response.ok) throw err(`ChatGPT file download failed with HTTP ${response.status}`,502,'FILE_DOWNLOAD_FAILED');
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length > maxBytes) throw err('ChatGPT file exceeds upload limit',413,'FILE_TOO_LARGE');
  let name = path.basename(String(fileName || file.file_name || `chatgpt-${file.file_id}.bin`)).replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').trim();
  if (!name) name = 'chatgpt-file.bin';
  const ext = path.extname(name), base = path.basename(name,ext);
  let target = clean(path.posix.join(clean(directory),name)), attempt = 0;
  while (await findEntry(workspaceId,target).catch(()=>null)) {
    attempt += 1; if (attempt >= 1000) throw err('Unable to choose a unique destination filename',409,'FILE_NAME_CONFLICT');
    target = clean(path.posix.join(clean(directory),`${base} (${attempt})${ext}`));
  }
  await requireCapability(identity.user,workspaceId,target,'create');
  const saved: any = await writeFileBytes({ workspaceId, path:target, bytes:raw, mimeType:file.mime_type||undefined, userId:identity.userId, preferText:false, upsert:false });
  return { uploaded:true,metadata:{path:target,bytes:raw.length,mimeType:saved.mime_type,sha256:hash(raw),chatgptFileId:file.file_id,originalFileName:file.file_name||null,renamedOnConflict:attempt>0} };
}

export async function createFolderCloud(identity: CloudMcpIdentity, workspaceId: string, folderPath: string, createParents = false) {
  requireWrite(identity);
  await chooseWorkspace(identity,workspaceId);
  const p=clean(folderPath);
  if(!p||protectedWorkspacePath(p)||p.toLowerCase().startsWith('_trash/'))throw err('Protected OrbitFS system path',403,'PROTECTED_SYSTEM_PATH');
  await requireCapability(identity.user,workspaceId,p,'create');
  if(await findEntry(workspaceId,p).catch(()=>null))throw err('Path already exists',409,'ENTRY_EXISTS');
  if(!createParents) {
    const parent=path.posix.dirname(p); if(parent!=='.' && parent && !(await findEntry(workspaceId,parent).catch(()=>null))) throw err('Parent folder not found',404,'PARENT_FOLDER_NOT_FOUND');
  }
  if(createParents) {
    const parts=p.split('/'); let current='';
    for(const part of parts){current=current?`${current}/${part}`:part;if(!(await findEntry(workspaceId,current).catch(()=>null)))await createCloudFolder(workspaceId,current,identity.userId);}
  } else await createCloudFolder(workspaceId,p,identity.userId);
  return {workspaceId,path:p,created:true};
}

export async function moveEntryCloud(identity: CloudMcpIdentity,workspaceId:string,sourcePath:string,destinationPath:string){
  requireWrite(identity);await chooseWorkspace(identity,workspaceId);
  const source=clean(sourcePath),destination=clean(destinationPath);
  await requireCapability(identity.user,workspaceId,source,'move');await requireCapability(identity.user,workspaceId,destination,'create');
  await moveCloudEntry(workspaceId,source,destination);return {workspaceId,sourcePath:source,destinationPath:destination};
}

export async function deleteEntryCloud(identity: CloudMcpIdentity,workspaceId:string,filePath:string){
  requireWrite(identity);await chooseWorkspace(identity,workspaceId);
  const p=clean(filePath);if(!p||protectedWorkspacePath(p)||p.toLowerCase().startsWith('_trash/'))throw err('Protected OrbitFS path',403,'PROTECTED_SYSTEM_PATH');
  await requireCapability(identity.user,workspaceId,p,'delete');
  const entry:any=await findEntry(workspaceId,p);if(!entry)throw err('Entry not found',404,'ENTRY_NOT_FOUND');
  const db=getSupabaseAdmin(),trashId=crypto.randomUUID(),prefix=`_trash/${trashId}/${path.posix.basename(p)}`;
  const rows=await db.from('orbitfs_files').select('*').eq('workspace_id',workspaceId).is('deleted_at',null);
  if(rows.error)throw rows.error;
  const affected=(rows.data||[]).filter((row:any)=>row.path===p||String(row.path||'').startsWith(p+'/')).sort((a:any,b:any)=>String(a.path).length-String(b.path).length);
  const storage=db.storage.from('orbitfs-files');
  for(const row of affected){
    const suffix=row.path===p?'':String(row.path).slice(p.length+1);
    const nextPath=clean([prefix,suffix].filter(Boolean).join('/'));let nextStorage=row.storage_path;
    if(row.storage_path){nextStorage=storagePath(workspaceId,nextPath);const moved=await storage.move(row.storage_path,nextStorage);if(moved.error)throw moved.error;}
    const updated=await db.from('orbitfs_files').update({path:nextPath,storage_path:nextStorage,deleted_at:now(),updated_at:now()}).eq('id',row.id);if(updated.error)throw updated.error;
  }
  return{workspaceId,trashId,originalPath:p,path:prefix,recoverable:true,affected:affected.length};
}

export async function fileInfoCloud(identity:CloudMcpIdentity,workspaceId:string,filePath:string){
  await chooseWorkspace(identity,workspaceId);const p=clean(filePath);await requireCapability(identity.user,workspaceId,p,'read');
  const entry:any=await findEntry(workspaceId,p);if(!entry)throw err('Entry not found',404,'ENTRY_NOT_FOUND');
  let sha256:string|null=null;if(entry.kind==='file'){try{sha256=hash(Buffer.from(await readEntryBytes(entry)));}catch{}}
  return{path:p,type:entry.kind==='folder'?'dir':'file',bytes:Number(entry.size_bytes||0),mimeType:entry.mime_type||null,modifiedAt:entry.updated_at,createdAt:entry.created_at,sha256};
}

export async function readManyCloud(identity:CloudMcpIdentity,workspaceId:string,paths:string[],maxCharacters=500000){
  const results:any[]=[];let remaining=maxCharacters;
  for(const p of paths.slice(0,100)){if(remaining<=0)break;try{const r=await readFileCloud(identity,workspaceId,p,'text',remaining);results.push({path:p,ok:true,content:r.content,metadata:r.metadata});remaining-=String(r.content||'').length;}catch(error:any){results.push({path:p,ok:false,error:error?.message||String(error),code:error?.code||'READ_FAILED'});}}
  return{results,returnedCharacters:maxCharacters-remaining};
}

export async function editFileCloud(identity:CloudMcpIdentity,workspaceId:string,filePath:string,oldText:string,newText:string,expectedSha256:string){
  const current=await readFileCloud(identity,workspaceId,filePath,'text',1500000,20971520);
  if(String(current.metadata.sha256).toLowerCase()!==String(expectedSha256).toLowerCase())throw err('File changed since it was read',409,'FILE_VERSION_CONFLICT');
  const source=String(current.content||''),count=oldText?source.split(oldText).length-1:0;
  if(count!==1)throw err(count===0?'Search text was not found':'Search text matched more than once',409,count===0?'EDIT_TEXT_NOT_FOUND':'EDIT_TEXT_AMBIGUOUS');
  const next=source.replace(oldText,newText);
  return writeFileCloud(identity,workspaceId,filePath,next,{mode:'update',encoding:'utf8',expectedSha256});
}

export async function profileCommandCloud(identity:CloudMcpIdentity,workspaceId:string,command:string,payload:any={},profileId?:string|null,summary=''){
  requireWrite(identity);await chooseWorkspace(identity,workspaceId);
  const role=await workspaceRole(identity.user,workspaceId);
  const actor = identity.username || identity.userId;
  try{
    if(command==='edit'&&profileId)return{applied:true,profile:await updateProfile(workspaceId,profileId,payload.patch||payload,actor,role,identity.userId),message:'Profile edit completed.'};
    if(command==='create')return{applied:true,profile:await createProfile(workspaceId,payload.profile||payload,actor,role,identity.userId),message:'Profile create completed.'};
    if(command==='archive'&&profileId)return{applied:true,profile:await deleteProfile(workspaceId,profileId,actor,role,identity.userId),message:'Profile archive completed.'};
    if(command==='repair')return{applied:true,result:await repairProfileState(workspaceId,actor,role,identity.userId),message:'Profile repair/migration completed.'};
    if(command==='import')return{applied:true,result:await importProfileState(workspaceId,payload,actor,role,identity.userId),message:'Profile import completed.'};
  }catch(error:any){
    if([401,403].includes(Number(error?.status||0))){
      const request=await createProfileCommandRequest(workspaceId,{command,profileId:profileId||null,payload,summary},actor,role,identity.userId,identity.role);
      return{applied:false,request,message:`Profile ${command} queued for approval.`};
    }
    throw error;
  }
  throw err('Unknown profile command',400,'PROFILE_COMMAND_UNKNOWN');
}

export async function exportProfilesCloud(identity:CloudMcpIdentity,workspaceId:string,profileId?:string){
  await chooseWorkspace(identity,workspaceId);const role=await workspaceRole(identity.user,workspaceId);
  const data:any=await exportProfileState(workspaceId,role,identity.userId,identity.role);
  const profiles=(data.profiles||data.export?.profiles||[]);const selected=profileId?profiles.filter((p:any)=>String(p.id)===String(profileId)):profiles;
  if(profileId&&!selected.length)throw err('Profile not found or export access denied',404,'PROFILE_NOT_FOUND');
  return{version:data.version||data.export?.version||3,exportedAt:data.exportedAt||data.export?.exportedAt||now(),profiles:selected};
}

export async function knowledgeOverviewCloud(identity:CloudMcpIdentity,workspaceId:string){await chooseWorkspace(identity,workspaceId);return presentLibrary(identity.user,workspaceId);}
export async function searchKnowledgeCloud(identity:CloudMcpIdentity,workspaceId:string,input:any){await chooseWorkspace(identity,workspaceId);return retrieveLibrary(identity.user,workspaceId,{query:input.query||'',itemIds:input.itemIds,sectionIds:input.sectionIds,limit:input.limit||12,maxChars:input.maxCharacters||12000});}
export async function knowledgeSectionCloud(identity:CloudMcpIdentity,workspaceId:string,itemId:string,sectionId:string){await chooseWorkspace(identity,workspaceId);const state:any=await readLibrary(workspaceId);const item=(state.items||[]).find((x:any)=>String(x.id)===String(itemId));const section=(state.sections||[]).find((x:any)=>String(x.itemId)===String(itemId)&&String(x.id)===String(sectionId));if(!item||!section)throw err('Knowledge section not found',404,'KNOWLEDGE_SECTION_NOT_FOUND');return{item,section,content:section.content||'',entities:(state.entityMentions||[]).filter((x:any)=>x.sectionId===section.id),events:(state.events||[]).filter((x:any)=>x.sectionId===section.id),facts:(state.facts||[]).filter((x:any)=>x.sectionId===section.id),factRelations:(state.factRelations||[]).filter((x:any)=>x.sourceFactId&&((state.facts||[]).some((f:any)=>f.id===x.sourceFactId&&f.sectionId===section.id)))};}
export async function resolveKnowledgeTargetCloud(identity:CloudMcpIdentity,workspaceId:string,role:string){await chooseWorkspace(identity,workspaceId);return resolveLibraryRoleTargets(identity.user,workspaceId,role);}
export async function knowledgeLineageCloud(identity:CloudMcpIdentity,workspaceId:string,itemId:string){await chooseWorkspace(identity,workspaceId);const state:any=await readLibrary(workspaceId);const item=(state.items||[]).find((x:any)=>String(x.id)===String(itemId));if(!item)throw err('Knowledge item not found',404,'KNOWLEDGE_ITEM_NOT_FOUND');const links=(state.links||[]).filter((l:any)=>String(l.fromItemId||l.sourceItemId)===String(itemId)||String(l.toItemId||l.targetItemId)===String(itemId));const relatedIds=new Set(links.flatMap((l:any)=>[l.fromItemId||l.sourceItemId,l.toItemId||l.targetItemId]).filter(Boolean).map(String));const nodes=(state.items||[]).filter((x:any)=>relatedIds.has(String(x.id))||String(x.id)===String(itemId));const current=nodes.filter((x:any)=>x.currentTarget===true||['active','final'].includes(String(x.lifecycleState||x.lifecycle)));return{item,nodes,current,links,derivedFrom:links.filter((l:any)=>String(l.fromItemId||l.sourceItemId)===String(itemId)&&String(l.relation||l.type)==='derived_from').map((l:any)=>(state.items||[]).find((x:any)=>String(x.id)===String(l.toItemId||l.targetItemId))).filter(Boolean)};}
export async function knowledgeImpactCloud(identity:CloudMcpIdentity,workspaceId:string,itemId:string){await chooseWorkspace(identity,workspaceId);const state:any=await readLibrary(workspaceId);const item=(state.items||[]).find((x:any)=>String(x.id)===String(itemId));if(!item)throw err('Knowledge item not found',404,'KNOWLEDGE_ITEM_NOT_FOUND');const links=(state.links||[]).filter((l:any)=>String(l.fromItemId||l.sourceItemId)===String(itemId)||String(l.toItemId||l.targetItemId)===String(itemId));const linkedIds=new Set(links.flatMap((l:any)=>[l.fromItemId||l.sourceItemId,l.toItemId||l.targetItemId]).filter(Boolean).map(String));linkedIds.delete(String(itemId));const linkedItems=(state.items||[]).filter((x:any)=>linkedIds.has(String(x.id)));const usage=(state.usage||[]).filter((u:any)=>String(u.itemId||u.knowledgeItemId)===String(itemId));return{item,affectedCount:linkedItems.length+usage.length,linkedItems,usage,links};}

export async function refreshPermissionsCloud(identity:CloudMcpIdentity){const workspaces=await accessibleMcpWorkspaces(identity.user,true,identity.clientWorkspaceIds);identity.workspaceSnapshot=workspaces;identity.workspaceIds=workspaces.map((w:any)=>String(w.id));if(identity.currentWorkspaceId&&!identity.workspaceIds.includes(identity.currentWorkspaceId))identity.currentWorkspaceId=identity.workspaceIds[0]||null;return{systemRole:identity.role,workspaceRoles:workspaces.map((w:any)=>({workspaceId:w.id,workspaceName:w.name,role:w.permission||w.role||'viewer'})),workspaceIds:identity.workspaceIds};}
export async function auditSystemCommand(identity:CloudMcpIdentity,eventType:string,details:any={}){const db=getSupabaseAdmin();await db.from('mcp_audit_log').insert({scope_id:identity.currentWorkspaceId||'global',actor_user_id:identity.userId,event_type:eventType,details});}
export async function systemStatusCloud(identity:CloudMcpIdentity){const db=getSupabaseAdmin();const [runtime,sessions]=await Promise.all([db.from('mcp_runtime_state').select('*').eq('id',1).maybeSingle(),db.from('mcp_sessions').select('*').eq('status','active').order('last_seen_at',{ascending:false}).limit(100)]);return{runtime:runtime.data||null,sessions:sessions.data||[],database:true,filesystem:false,storage:'supabase'};}
