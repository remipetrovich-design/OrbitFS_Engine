import { z } from 'zod';
import { callWorkspaceApi, callWorkspaceRawApi, profileApiPath } from '../services/workspace-client.js';

const openAIFileSchema = z.object({
  download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional()
}).strict();
const profileCommandOutputSchema = z.object({
  ok: z.boolean(), message: z.string(), workspaceId: z.string(), profileId: z.string().optional(), applied: z.boolean().optional()
}).passthrough();
const profileExportOutputSchema = z.object({
  ok: z.boolean(), message: z.string(), workspaceId: z.string(), profileCount: z.number().int().nonnegative(), format: z.enum(['json','md'])
}).passthrough();

function toolResult(text, data, meta) {
  return { content: [{ type: 'text', text }], structuredContent: { ok: true, message: text, ...data }, _meta: { ...meta, orbitfsUiState: data } };
}
async function command(identity, workspaceId, name, payload = {}, profileId = null, summary = '') {
  return callWorkspaceApi(identity, profileApiPath(workspaceId, '/commands'), { method: 'POST', body: { command: name, payload, profileId, summary } });
}
function commandText(result, action) {
  return result.applied ? `${action} completed.` : `${action} queued for approval${result.request?.id ? ` (${result.request.id})` : ''}.`;
}
function sectionMarkdown(section = {}) {
  if (section.id === 'references' && Array.isArray(section.references)) return section.references.map((ref) => `- ${ref.path}`).join('\n') || String(section.content || '');
  if (section.kind === 'relationships' && Array.isArray(section.relationships)) return section.relationships.map((rel) => `- ${rel.profileName || rel.profileId}: ${rel.fromLabel || 'relationship'}`).join('\n');
  return String(section.content || '').trim();
}
function profileMarkdown(profile = {}) {
  const lines = [`# PROFILE — ${profile.name || 'Untitled'}`, '', `Profile type: ${profile.type || 'person-master'}`, `Status: ${profile.status || 'active'}`, `Classification: ${profile.classification || 'personal-record'}`];
  for (const section of profile.sections || []) {
    if (section?.removed === true || section?.enabled === false || section?.canRead === false) continue;
    const body = sectionMarkdown(section);
    if (!body) continue;
    lines.push('', `## ${section.title || section.name || 'Section'}`, '', body);
  }
  return lines.join('\n').trim();
}
async function fetchChatGPTFile(file, maxBytes = 104857600) {
  const url = new URL(file.download_url);
  if (url.protocol !== 'https:') throw Object.assign(new Error('ChatGPT file URL must use HTTPS'), { status: 400, code: 'INVALID_FILE_DOWNLOAD_URL' });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw Object.assign(new Error(`ChatGPT file download failed with HTTP ${response.status}`), { status: 502, code: 'FILE_DOWNLOAD_FAILED' });
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw Object.assign(new Error('Profile import file is too large'), { status: 413, code: 'FILE_TOO_LARGE' });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw Object.assign(new Error('Profile import file is too large'), { status: 413, code: 'FILE_TOO_LARGE' });
  return buffer;
}

export function registerProfileTools(server, { requireLicence, identity, meta }) {
  server.registerTool('save_profile_changes', {
    title: 'Save OrbitFS profile changes',
    description: 'Normal profile edit command. OrbitFS applies directly when the user has profile edit permission, otherwise queues for approval when queue permission is allowed.',
    inputSchema: { workspaceId: z.string(), profileId: z.string(), profilePatch: z.record(z.string(), z.any()), summary: z.string().optional() },
    outputSchema: profileCommandOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, profileId, profilePatch, summary = '' }) => {
    requireLicence();
    const result = await command(identity, workspaceId, 'edit', { patch: profilePatch }, profileId, summary);
    return toolResult(commandText(result, 'Profile edit'), { ...result, workspaceId, profileId }, meta);
  });
  server.registerTool('create_profile', {
    title: 'Create OrbitFS profile',
    description: 'Create a new Base Panel profile. Applies directly with create permission or queues for approval with queue permission.',
    inputSchema: { workspaceId: z.string(), profile: z.record(z.string(), z.any()), summary: z.string().optional() },
    outputSchema: profileCommandOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, profile, summary = '' }) => {
    requireLicence(); const result = await command(identity, workspaceId, 'create', { profile }, null, summary);
    return toolResult(commandText(result, 'Profile create'), { ...result, workspaceId }, meta);
  });
  server.registerTool('archive_profile', {
    title: 'Archive OrbitFS profile',
    description: 'Archive/delete a profile using OrbitFS recoverable profile deletion state. Applies directly with delete permission or queues for approval.',
    inputSchema: { workspaceId: z.string(), profileId: z.string(), summary: z.string().optional() },
    outputSchema: profileCommandOutputSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, profileId, summary = '' }) => {
    requireLicence(); const result = await command(identity, workspaceId, 'archive', {}, profileId, summary);
    return toolResult(commandText(result, 'Profile archive'), { ...result, workspaceId, profileId }, meta);
  });
  server.registerTool('repair_profiles', {
    title: 'Repair or migrate OrbitFS profiles',
    description: 'Command-only profile repair/migration. Normalizes active profiles to the current schema, repairs core sections, relationship reverses, bundles and invalid slots.',
    inputSchema: { workspaceId: z.string(), summary: z.string().optional() },
    outputSchema: profileCommandOutputSchema, outputSchema: profileCommandOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, summary = '' }) => {
    requireLicence(); const result = await command(identity, workspaceId, 'repair', {}, null, summary);
    return toolResult(commandText(result, 'Profile repair/migration'), { ...result, workspaceId }, meta);
  });
  server.registerTool('import_profile', {
    title: 'Import OrbitFS profile JSON or ZIP',
    description: 'Import profile JSON/ZIP into Base Panel. Native ChatGPT files are parsed by the Panel before direct apply or queueing, so queued imports do not depend on temporary ChatGPT URLs.',
    inputSchema: { workspaceId: z.string(), file: openAIFileSchema.optional(), profileData: z.any().optional(), intent: z.literal('orbitfs').optional(), maxBytes: z.number().int().positive().max(104857600).optional() },
    outputSchema: profileCommandOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { ...meta, 'openai/fileParams': ['file'], 'openai/toolInvocation/invoking': 'Importing profile into OrbitFS...', 'openai/toolInvocation/invoked': 'Profile import processed' }
  }, async ({ workspaceId, file, profileData, intent, maxBytes = 104857600 }) => {
    requireLicence();
    if (Boolean(file) === Boolean(profileData)) throw Object.assign(new Error('Provide exactly one of file or profileData'), { status: 400, code: 'INVALID_PROFILE_IMPORT_INPUT' });
    let result;
    if (file) {
      if (intent !== 'orbitfs') throw Object.assign(new Error('Explicit OrbitFS import intent is required'), { status: 400, code: 'ORBITFS_FILE_TRANSFER_INTENT_REQUIRED' });
      const buffer = await fetchChatGPTFile(file, maxBytes);
      result = await callWorkspaceRawApi(identity, profileApiPath(workspaceId, '/import-file'), { body: buffer, headers: { 'content-type': file.mime_type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.file_name || 'Imported profile') } });
    } else result = await command(identity, workspaceId, 'import', profileData, null, 'Import profile data');
    return toolResult(commandText(result, 'Profile import'), { ...result, workspaceId }, meta);
  });
  server.registerTool('export_profile', {
    title: 'Export OrbitFS profile JSON or Markdown',
    description: 'Export one permitted profile, or all permitted profiles, as JSON or Markdown. Export permission is required; exports are never queued.',
    inputSchema: { workspaceId: z.string(), profileId: z.string().optional(), format: z.enum(['json','md']).optional() },
    outputSchema: profileExportOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta
  }, async ({ workspaceId, profileId, format = 'json' }) => {
    requireLicence();
    const data = await callWorkspaceApi(identity, profileApiPath(workspaceId, '/export'));
    const profiles = data.export?.profiles || [];
    const selected = profileId ? profiles.filter((profile) => profile.id === profileId) : profiles;
    if (profileId && !selected.length) throw Object.assign(new Error('Profile not found or export access denied'), { status: 404, code: 'PROFILE_NOT_FOUND' });
    const text = format === 'md' ? selected.map(profileMarkdown).join('\n\n---\n\n') : JSON.stringify(profileId ? selected[0] : { version: data.export?.version || 3, exportedAt: data.export?.exportedAt, profiles: selected }, null, 2);
    return { content: [{ type: 'text', text }], structuredContent: { ok: true, message: `Exported ${selected.length} profile${selected.length === 1 ? '' : 's'} as ${format}.`, workspaceId, profileCount: selected.length, format }, _meta: meta };
  });
}
