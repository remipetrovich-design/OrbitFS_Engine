import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceRoot } from '../store.js';
import { callWorkspaceApi, profileApiPath } from './workspace-client.js';

const PROFILE_DISPLAY_LIMIT = 500000;
const LEAD_SECTION_IDS = ['core-information', 'labels'];
const EMPTY_LABELS = { primary: [], context: [], system: [], sensitive: [] };
const SECTION_TABS = {
  'profile-settings': 'Access & MCP',
  'mcp-load-rules': 'Access & MCP',
  'core-information': 'Identity',
  labels: 'Labels',
  relationships: 'Relationships',
  background: 'History',
  'who-they-are': 'History',
  timeline: 'History',
  'current-status': 'Records',
  'key-events': 'Records',
  'private-notes': 'Private',
  legal: 'Private',
  wellbeing: 'Private',
  'connected-files': 'Records'
};

export async function listWorkspaceEntries(workspaceId, relativePath = '') {
  const root = await workspaceRoot(workspaceId);
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const absolute = path.resolve(root, clean);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw Object.assign(new Error('Path escaped workspace root'), { status: 400 });
  }
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith('_') && entry.name !== '.orbitfs-workspace.json')
    .map((entry) => ({
      name: entry.name,
      path: path.posix.join(clean, entry.name),
      type: entry.isDirectory() ? 'folder' : 'file'
    }))
    .sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder') || a.name.localeCompare(b.name));
}
function stripSensitiveLabelBlock(content = '') {
  const lines = String(content || '').split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.trim().replace(/:$/, '').toLowerCase();
    if (heading === 'sensitive labels') {
      skipping = true;
      continue;
    }
    if (['primary labels', 'context labels', 'system labels'].includes(heading)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').trim();
}

function sanitizeSection(section, permissions = {}) {
  const copy = structuredClone(section || {});
  if (copy.id !== 'labels' || permissions.view_restricted) return copy;
  if (copy.labels && typeof copy.labels === 'object') {
    copy.labels = { ...copy.labels, sensitive: [] };
  }
  copy.content = stripSensitiveLabelBlock(copy.content);
  return copy;
}
function profileSectionsForMcp(profile, permissions = {}) {
  return (profile.sections || [])
    .filter((section) => section?.removed !== true && section?.enabled !== false && section?.canRead !== false && section?.loadIntoMcp !== false)
    .map((section) => sanitizeSection(section, permissions));
}

function markdownValue(value) {
  if (Array.isArray(value)) return value.map((item) => `- ${String(item)}`).join('\n');
  if (value && typeof value === 'object') return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '').trim();
}

function compactSectionText(text = '', limit = 900) {
  const value = String(text || '').trim();
  if (!value || value.length <= limit) return value || '_No content_';
  const clipped = value.slice(0, limit);
  const boundary = Math.max(clipped.lastIndexOf('\n\n'), clipped.lastIndexOf('. '));
  return (boundary > 300 ? clipped.slice(0, boundary + 1) : clipped).trim() + '…';
}

function sectionMarkdown(section = {}) {
  if (section.id === 'references') {
    const refs = Array.isArray(section.references) ? section.references : [];
    const manual = String(section.content ?? '').trim();
    const lines = refs.map((ref) => `- ${ref.path}${ref.type ? ` | ${ref.type}` : ''}${ref.source ? ` | ${ref.source}` : ''}`);
    if (manual) lines.push('', manual);
    return lines.join('\n').trim() || '_No references yet_';
  }
  if (section.kind === 'relationships' && Array.isArray(section.relationships)) return section.relationships.map((rel) => `- ${rel.profileName || rel.profileId || 'Linked profile'}: ${rel.fromLabel || 'relationship'}${rel.fromDate ? ` | from ${rel.fromDate}` : ''}${rel.toDate ? ` | to ${rel.toDate}` : ''}${rel.status ? ` | ${rel.status}` : ''}${rel.notes ? ` — ${rel.notes}` : ''}`).join('\n') || '_No relationships yet_';
  if (section.kind === 'timeline' && Array.isArray(section.entries)) return section.entries.map((entry) => `- ${entry.date || 'No date'} — ${entry.title || 'Untitled'}${entry.linkedFile ? ` — ${entry.linkedFile}` : ''}${entry.notes ? ` — ${entry.notes}` : ''}`).join('\n') || '_No timeline entries yet_';
  return String(section.content ?? '').trim() || '_No content_';
}
function orderedProfileSections(profile, permissions = {}) {
  const internal = new Set(['profile-settings','mcp-load-rules']);
  const sections = profileSectionsForMcp(profile, permissions).filter((section) => !internal.has(section.id));
  const order = ['core-information','labels','background','who-they-are','current-status','relationships','history','timeline','key-events','records','references','private-notes','legal','wellbeing','connected-files'];
  return [...order.map((id) => sections.find((section) => section.id === id)).filter(Boolean), ...sections.filter((section) => !order.includes(section.id))];
}
function sectionsForDetail(sections, detail) { if (detail === 'full') return sections; if (detail === 'summary') return sections.filter((section) => ['core-information','labels','background','who-they-are','current-status','relationships','history','references'].includes(section.id)); return sections; }
function formatProfile(profile, detail, permissions = {}) {
  const sections = sectionsForDetail(orderedProfileSections(profile, permissions), detail);
  const lines = [`# PROFILE — ${profile.name || 'Untitled profile'}`,'','> OrbitFS Profile Document · Export version 3','',`Profile type: ${profile.type || 'person-master'}`,`Status: ${profile.status || 'active'}`,`Classification: ${profile.classification || 'personal-record'}`];
  for (const section of sections) {
    const title=String(section?.title||section?.name||'Section').trim(); let content=sectionMarkdown(section); const source=String(section?.sourcePath??'').trim();
    lines.push('',`## ${title || 'Section'}`); if(source) lines.push('',`Source: ${source}`);
    if(section?.detailLevel==='summary'||detail==='summary') content=compactSectionText(content);
    lines.push('',content||'_No content_');
  }
  return lines.join('\n').trim();
}

function profileMatches(profile = {}, reference = '') {
  const value = String(reference || '').trim();
  if (!value) return false;
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return [profile.id, profile.name, `Profiles/${profile.name}`, `Profiles/${profile.id}`]
    .map((item) => String(item || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase())
    .includes(normalized);
}

function activeProfileMatches(item = {}, reference = '') {
  if (item?.source !== 'profile') return false;
  const profile = { id: item.profileId, name: item.profileName || String(item.path || '').replace(/^Profiles\//i, '') };
  return profileMatches(profile, reference) || profileMatches({ ...profile, id: item.path }, reference);
}

function compactProfileContent(text = '') {
  const value = String(text || '');
  return value.length > PROFILE_DISPLAY_LIMIT ? value.slice(0, PROFILE_DISPLAY_LIMIT) : value;
}

export function profileContextItem(result, { profileId, detail = 'standard', sourceEntry = {}, maxCharacters = PROFILE_DISPLAY_LIMIT } = {}) {
  const full = String(result.content || '');
  const content = full.slice(0, Math.max(0, Math.min(Number(maxCharacters || PROFILE_DISPLAY_LIMIT), PROFILE_DISPLAY_LIMIT)));
  return {
    ...sourceEntry,
    path: `Profiles/${result.profile.name}`,
    source: 'profile',
    profileId: String(result.profile.id || profileId || ''),
    profileName: result.profile.name,
    detail,
    profileFormatVersion: 2,
    status: 'transferred',
    opened: true,
    extracted: true,
    transferred: true,
    characters: content.length,
    displayCharacters: content.length,
    fullCharacters: full.length,
    truncated: content.length < full.length,
    content,
    displayText: content
  };
}

export async function listWorkspaceProfiles(workspaceId, identity = {}) {
  const result = await callWorkspaceApi(identity, profileApiPath(workspaceId, '/catalog'));
  const permissions = result.permissions || {};
  const profiles = (result.profiles || []).map((profile) => ({
    id: profile.id,
    name: profile.name,
    type: profile.type || 'master',
    status: profile.status || 'active',
    classification: profile.classification || 'workspace',
    restricted: Boolean(profile.restricted),
    srestricted: Boolean(profile.srestricted),
    sectionCount: Number(profile.sectionCount || (Array.isArray(profile.sections) ? profileSectionsForMcp(profile, permissions).length : 0)),
    relationshipCount: Number(profile.relationshipCount || (Array.isArray(profile.sections) ? profileSectionsForMcp(profile, permissions).find((section) => section.kind === 'relationships')?.relationships?.length || 0 : 0)),
    labels: profile.labels || (Array.isArray(profile.sections) ? profileSectionsForMcp(profile, permissions).find((item) => item.id === 'labels')?.labels : null) || EMPTY_LABELS,
    updatedAt: profile.updatedAt || null
  }));
  const accessibleIds = new Set(profiles.map((profile) => String(profile.id)));
  const profileBundles = (result.profileBundles || []).map((bundle) => ({ id: String(bundle.id), name: bundle.name, description: bundle.description || '', profileIds: (bundle.profileIds || []).map(String).filter((id) => accessibleIds.has(id)) })).filter((bundle) => bundle.profileIds.length > 0);
  return { enabled: result.enabled !== false, settings: result.settings || {}, slots: result.slots || { master: null, additional: null }, permissions, profiles, profileBundles };
}
export async function loadWorkspaceProfile(workspaceId, profileId, detail = 'standard', identity = {}) {
  const result = await callWorkspaceApi(identity, profileApiPath(workspaceId));
  const profile = (result.profiles || []).find((item) => item.id === profileId);
  if (!profile) {
    throw Object.assign(new Error('Profile is unavailable or access is denied'), { status: 403, code: 'PROFILE_ACCESS_DENIED' });
  }
  const permissions = result.permissions || {};
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      type: profile.type,
      status: profile.status,
      classification: profile.classification,
      restricted: Boolean(profile.restricted),
      srestricted: Boolean(profile.srestricted)
    },
    detail,
    content: formatProfile(profile, detail, permissions),
    references: ((profile.sections || []).find((section) => section?.id === 'references' && section?.removed !== true && section?.canRead !== false && section?.loadIntoMcp !== false)?.references || []).filter((ref) => ref?.path),
    followReferences: ((profile.sections || []).find((section) => section?.id === 'references' && section?.removed !== true && section?.canRead !== false && section?.loadIntoMcp !== false)?.followReferences === true)
  };
}

export async function resolveWorkspaceProfile(workspaceId, reference, identity = {}, activeContext = null) {
  const query = String(reference || '').trim();
  if (!query) throw Object.assign(new Error('profileId, profileName, or path is required'), { status: 400, code: 'PROFILE_REFERENCE_REQUIRED' });
  const loaded = (activeContext?.files || []).find((item) => activeProfileMatches(item, query)) || null;
  if ((loaded?.content || loaded?.displayText) && Number(loaded.profileFormatVersion || 0) >= 2) {
    return {
      source: 'active_context',
      profileId: String(loaded.profileId || ''),
      profileName: loaded.profileName || String(loaded.path || '').replace(/^Profiles\//i, ''),
      path: loaded.path,
      detail: loaded.detail || 'standard',
      content: compactProfileContent(loaded.displayText || loaded.content),
      item: loaded
    };
  }
  const catalog = await listWorkspaceProfiles(workspaceId, identity);
  const profile = (catalog.profiles || []).find((item) => profileMatches(item, query) || (loaded?.profileId && String(item.id) === String(loaded.profileId)));
  if (!profile) throw Object.assign(new Error('Profile is unavailable or access is denied'), { status: 403, code: 'PROFILE_ACCESS_DENIED' });
  const result = await loadWorkspaceProfile(workspaceId, profile.id, loaded?.detail || 'standard', identity);
  return {
    source: loaded ? 'active_context_refresh' : 'workspace_lookup',
    profileId: result.profile.id,
    profileName: result.profile.name,
    path: `Profiles/${result.profile.name}`,
    detail: loaded?.detail || 'standard',
    content: compactProfileContent(result.content),
    profile: result.profile
  };
}
