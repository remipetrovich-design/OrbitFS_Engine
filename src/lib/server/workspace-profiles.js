// @ts-nocheck
import crypto from 'node:crypto';
import { getSupabaseAdmin } from './supabase';

export const PROFILE_PERMISSIONS = Object.freeze([
  'view','create','edit','edit_assigned','queue_profile_commands','approve_profile_commands','delete','import','export','repair',
  'manage_fields','manage_templates','manage_permissions','manage_startup',
  'load_context','view_restricted','edit_restricted'
]);

export const PROFILE_ROLE_DEFAULTS = Object.freeze({
  owner: Object.freeze(Object.fromEntries(PROFILE_PERMISSIONS.map((key) => [key, true]))),
  editor: Object.freeze({ view:true, create:true, edit:true, edit_assigned:true, queue_profile_commands:true, approve_profile_commands:true, delete:true, import:true, export:true, repair:false, manage_fields:false, manage_templates:false, manage_permissions:false, manage_startup:false, load_context:true, view_restricted:false, edit_restricted:false }),
  contributor: Object.freeze({ view:true, create:true, edit:false, edit_assigned:true, queue_profile_commands:true, approve_profile_commands:false, delete:false, import:true, export:false, repair:false, manage_fields:false, manage_templates:false, manage_permissions:false, manage_startup:false, load_context:true, view_restricted:false, edit_restricted:false }),
  viewer: Object.freeze({ view:true, create:false, edit:false, edit_assigned:false, queue_profile_commands:false, approve_profile_commands:false, delete:false, import:false, export:false, repair:false, manage_fields:false, manage_templates:false, manage_permissions:false, manage_startup:false, load_context:false, view_restricted:false, edit_restricted:false })
});

const now = () => new Date().toISOString();
const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max);

const MiB = 1024 * 1024;
const DEFAULT_PROFILE_LIMITS = Object.freeze({
  maxProfiles: 20,
  maxProfileSizeBytes: 50 * MiB,
  maxTotalProfileStorageBytes: 0
});

const defaultState = () => ({
  version: 2,
  enabled: false,
  settings: { startupMode: 'summary', loadUserSlots: true, loadWorkspaceProfiles: [], ...DEFAULT_PROFILE_LIMITS },
  roleOverrides: {}, memberOverrides: {}, profileTypes: [], profiles: [], profileBundles: [], userSlots: {}, profileEditRequests: [], audit: []
});


function workspaceKey(workspaceRoot) {
  return String(workspaceRoot || '').replace(/\\/g, '/');
}

async function readProfileStateFromDb(workspaceRoot) {
  try {
    const workspaceId = workspaceKey(workspaceRoot);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from('orbitfs_profile_state').select('state').eq('workspace_id', workspaceId).maybeSingle();
    if (error) throw error;
    if (!data?.state) return null;
    return { ...defaultState(), ...data.state };
  } catch {
    return null;
  }
}

async function saveProfileStateToDb(workspaceRoot, state) {
  const workspaceId = workspaceKey(workspaceRoot);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('orbitfs_profile_state').upsert({
    workspace_id: workspaceId,
    state,
    updated_at: new Date().toISOString()
  }, { onConflict: 'workspace_id' });
  if (error) throw error;
}

function normaliseProfileState(state = {}) {
  const base = defaultState();
  const settings = { ...base.settings, ...(state.settings || {}) };
  settings.maxProfiles = Math.max(1, Math.min(10000, Number(settings.maxProfiles || DEFAULT_PROFILE_LIMITS.maxProfiles)));
  settings.maxProfileSizeBytes = Math.max(MiB, Math.min(10240 * MiB, Number(settings.maxProfileSizeBytes || DEFAULT_PROFILE_LIMITS.maxProfileSizeBytes)));
  settings.maxTotalProfileStorageBytes = Math.max(0, Math.min(1048576 * MiB, Number(settings.maxTotalProfileStorageBytes || 0)));
  return { ...base, ...state, version: Math.max(2, Number(state.version || 0)), settings, profileBundles: Array.isArray(state.profileBundles) ? state.profileBundles : [] };
}

function profileSizeBytes(profile) {
  return Buffer.byteLength(JSON.stringify(profile || {}), 'utf8');
}

function profileStorageStats(state) {
  const active = (state.profiles || []).filter((profile) => !profile.deletedAt);
  const entries = active.map((profile) => ({ id: profile.id, name: profile.name, sizeBytes: profileSizeBytes(profile) }));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return { count: entries.length, totalBytes, largestBytes: entries.reduce((max, entry) => Math.max(max, entry.sizeBytes), 0), entries };
}

function enforceProfileLimits(state, candidate = null, replacingId = null) {
  const stats = profileStorageStats(state);
  const existing = replacingId ? stats.entries.find((entry) => entry.id === replacingId) : null;
  const candidateBytes = candidate ? profileSizeBytes(candidate) : 0;
  if (!replacingId && candidate && stats.count >= state.settings.maxProfiles) throw Object.assign(new Error('Workspace profile limit reached'), { status: 409, code: 'PROFILE_COUNT_LIMIT_REACHED' });
  if (candidate && candidateBytes > state.settings.maxProfileSizeBytes) throw Object.assign(new Error('Profile exceeds the workspace profile size limit'), { status: 413, code: 'PROFILE_SIZE_LIMIT_REACHED' });
  const projectedTotal = stats.totalBytes - Number(existing?.sizeBytes || 0) + candidateBytes;
  if (state.settings.maxTotalProfileStorageBytes > 0 && projectedTotal > state.settings.maxTotalProfileStorageBytes) throw Object.assign(new Error('Workspace profile storage allowance exceeded'), { status: 413, code: 'PROFILE_STORAGE_LIMIT_REACHED' });
  return { candidateBytes, projectedTotal };
}

export async function readProfileState(workspaceRoot) {
  const dbState = await readProfileStateFromDb(workspaceRoot);
  return normaliseProfileState(dbState || defaultState());
}

export async function saveProfileState(workspaceRoot, state) {
  await saveProfileStateToDb(workspaceRoot, state);
  return state;
}

function sectionTemplate(id, title, kind = 'text', content = '', patch = {}) {
  return { id, title, kind, content, canRead: true, loadIntoMcp: true, detailLevel: 'summary', generated: true, locked: true, ...patch };
}


function baseProfileSections() {
  return [
    sectionTemplate('profile-settings', 'START / profile settings', 'settings', 'Profile type:\nStatus:\nClassification:\nRelationship type:\nRestricted:\nOne-line read:\n', { detailLevel: 'full' }),
    sectionTemplate('mcp-load-rules', 'MCP / startup load rules', 'text', 'Can MCP read this profile:\nDefault load:\nSections allowed:\nSections blocked unless explicitly loaded:\nSpecial instructions:\n'),
    sectionTemplate('core-information', 'Core information', 'core', 'Name:\nDate of birth:\nAge:\nCurrent location:\n', { detailLevel: 'full' }),
    sectionTemplate('labels', 'Labels', 'labels', 'Primary labels:\n- \n\nContext labels:\n- \n\nSystem labels:\n- \n\nSensitive labels:\n- \n', { labels: { primary: [], context: [], system: [], sensitive: [] } }),
    sectionTemplate('relationships', 'Relationships with others', 'relationships', 'Connected profile:\nRelationship:\nFrom date:\nTo date:\nStatus:\nNotes:\n', { relationships: [] }),
    sectionTemplate('background', 'Background', 'text', 'Relationship To Self:\n\nRole In The Collapse:\n'),
    sectionTemplate('who-they-are', 'Who they are', 'text', 'Who They Are:\n'),
    sectionTemplate('timeline', 'Timeline', 'timeline', 'Timeline Of Key Events:\n', { entries: [] }),
    sectionTemplate('current-status', 'Current status', 'text', 'Current Status:\nCurrent situation:\nCurrent contact status:\nCurrent legal / safety / support status:\nUnresolved issues:\nNext known dates:\n'),
    sectionTemplate('key-events', 'Key events / incidents', 'text', 'Event title:\nDate / period:\nPeople involved:\nWhat happened:\nWhy it matters:\nLinked files:\n'),
    sectionTemplate('private-notes', 'Private notes', 'text', 'Internal notes:\nInternal read:\nEmotional significance:\nThings to be careful with:\nThings not to assume:\n', { loadIntoMcp: false }),
    sectionTemplate('legal', 'Legal / court reference', 'text', 'Legal status:\nOrders / charges / matters:\nCourt dates:\nRestrictions:\nEvidence:\n', { loadIntoMcp: false }),
    sectionTemplate('wellbeing', 'Mental health / wellbeing reference', 'text', 'Mental health flags:\nPsychological Profile:\nCore fears:\nCore needs:\n', { loadIntoMcp: false }),
    sectionTemplate('connected-files', 'Connected files', 'text', 'Connected Files:\nAdditional source sections retained:\nRecent Context:\nAdditional Context:\n')
  ];
}
function mergeBaseSections(sections = []) {
  const existing = new Map((Array.isArray(sections) ? sections : []).map((section) => [section.id, section]));
  const base = baseProfileSections().map((section) => ({ ...section, ...(existing.get(section.id) || {}) }));
  return base.concat((Array.isArray(sections) ? sections : []).filter((section) => !base.some((baseSection) => baseSection.id === section.id)));
}

export function blankProfileTemplate() {
  return {
    version: 2,
    template: 'master_profile_section_base',
    profile: { name: '', type: 'person-master', status: 'active', classification: 'personal-record', restricted: false, srestricted: false, fields: {}, sections: baseProfileSections(), editorIds: [], viewerIds: [] }
  };
}

export function profilePermissions(state, role, userId) {
  const defaults = PROFILE_ROLE_DEFAULTS[role] ?? PROFILE_ROLE_DEFAULTS.viewer;
  const roleOverride = state.roleOverrides?.[role] ?? {};
  const memberOverride = state.memberOverrides?.[userId] ?? {};
  return Object.fromEntries(PROFILE_PERMISSIONS.map((key) => [key, Boolean(memberOverride[key] ?? roleOverride[key] ?? defaults[key])]));
}

export function requireProfilePermission(state, role, userId, permission) {
  const permissions = profilePermissions(state, role, userId);
  if (!permissions[permission]) {
    const error = new Error(`Profile permission required: ${permission}`);
    error.status = 403;
    error.code = 'PROFILE_PERMISSION_REQUIRED';
    throw error;
  }
  return permissions;
}

function parseProfileLabelGroups(section = {}) {
  const groups = { primary: [], context: [], system: [], sensitive: [] };
  if (section.labels && typeof section.labels === 'object') for (const key of Object.keys(groups)) groups[key] = Array.isArray(section.labels[key]) ? section.labels[key].map((v) => clean(v, 120)).filter(Boolean) : [];
  if (Object.values(groups).some((items) => items.length)) return groups;
  const map = { 'main labels': 'primary', 'primary labels': 'primary', 'associate labels': 'context', 'context labels': 'context', 'system labels': 'system', 'sensitive labels': 'sensitive' };
  let bucket = 'primary';
  for (const raw of String(section.content || '').split(/\n/)) { const line=raw.trim(); const heading=line.replace(/:$/, '').toLowerCase(); if (map[heading]) bucket=map[heading]; else if (/^[-*]\s+/.test(line)) { const value=clean(line.replace(/^[-*]\s+/, ''),120); if(value) groups[bucket].push(value); } }
  return groups;
}
function profileLabelContent(groups) { const block=(title,key)=>title+':\n'+(groups[key].length?groups[key].map((v)=>'- '+v).join('\n'):'- '); return [block('Primary labels','primary'),block('Context labels','context'),block('System labels','system'),block('Sensitive labels','sensitive')].join('\n\n')+'\n'; }
function sanitizeProfileLabels(profile, permissions) { const copy=JSON.parse(JSON.stringify(profile)); const section=(copy.sections||[]).find((item)=>item.id==='labels'); if(!section) return copy; const groups=parseProfileLabelGroups(section); if(!permissions.view_restricted) groups.sensitive=[]; section.labels=groups; section.content=profileLabelContent(groups); return copy; }
function protectLabelUpdates(existingProfile, incomingSections, permissions) { if(!Array.isArray(incomingSections)) return incomingSections; const existing=(existingProfile.sections||[]).find((s)=>s.id==='labels'); const incoming=incomingSections.find((s)=>s.id==='labels'); if(!existing||!incoming) return incomingSections; const oldGroups=parseProfileLabelGroups(existing), nextGroups=parseProfileLabelGroups(incoming); if(!permissions.manage_fields) nextGroups.system=oldGroups.system; if(!permissions.edit_restricted) nextGroups.sensitive=oldGroups.sensitive; incoming.labels=nextGroups; incoming.content=profileLabelContent(nextGroups); return incomingSections; }

function protectNewProfileLabels(profile, permissions) { const section=(profile.sections||[]).find((item)=>item.id==='labels'); if(!section) return profile; const groups=parseProfileLabelGroups(section); if(!permissions.manage_fields) groups.system=[]; if(!permissions.edit_restricted) groups.sensitive=[]; section.labels=groups; section.content=profileLabelContent(groups); return profile; }

function canAccessProfile(profile, permissions, userId, role = 'viewer', systemRole = 'user') {
  if (profile.deletedAt) return false;
  const privileged = role === 'owner' || systemRole === 'owner' || systemRole === 'admin';
  if (profile.srestricted && !privileged) return false;
  if (profile.restricted && !permissions.view_restricted) return false;
  if (!Array.isArray(profile.viewerIds) || profile.viewerIds.length === 0) return true;
  return profile.viewerIds.includes(userId) || profile.editorIds?.includes(userId);
}


function slugSection(value = '') {
  const key = String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ({
    'start-profile-settings': 'profile-settings',
    'profile-settings': 'profile-settings',
    'start': 'profile-settings',
    'core-information': 'core-information',
    'labels': 'labels',
    'relationships-with-others': 'relationships',
    'connected-profiles': 'relationships',
    'relationships': 'relationships',
    'background': 'background',
    'who-they-are': 'who-they-are',
    'timeline': 'timeline',
    'timeline-of-key-events': 'timeline',
    'current-status': 'current-status',
    'key-events-incidents': 'key-events',
    'key-events': 'key-events',
    'private-notes': 'private-notes',
    'legal-reference': 'legal',
    'legal-status': 'legal',
    'mental-health-wellbeing-reference': 'wellbeing',
    'mental-health-flags': 'wellbeing',
    'psychological-profile': 'wellbeing',
    'connected-files': 'connected-files',
    'mcp-startup-load-rules': 'mcp-load-rules',
    'mcp-load-rules': 'mcp-load-rules',
    'startup-load-rules': 'mcp-load-rules',
    'legal-court-reference': 'legal'
  })[key] || key;
}

function stripMarkdown(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\*\*(.*?)\*\*/g, '$1').replace(/^[-*]\s+/gm, '').trim();
}

function markdownSections(text = '') {
  const out = [];
  let current = null;
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (current && current.content.trim()) out.push(current);
      current = { title: h[1].trim(), content: '' };
    } else if (current) current.content += line + '\n';
  }
  if (current && current.content.trim()) out.push(current);
  return out;
}

function keyValues(text = '') {
  const out = {};
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let current = null;
  const normalKey = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const assign = (key, value) => {
    const cleanValue = stripMarkdown(value);
    if (!key || !cleanValue || /^[-*]?$/.test(cleanValue)) return;
    out[key] = out[key] ? out[key] + '\n' + cleanValue : cleanValue;
  };
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    const inline = line.match(/^\s*(?:[-*]\s*)?\*{0,2}([^:\n]+?)\*{0,2}\s*:\s*(.*?)\s*$/);
    if (inline) {
      current = normalKey(inline[1]);
      if (inline[2]) assign(current, inline[2]);
      continue;
    }
    if (current && line) assign(current, line);
  }
  return out;
}

function asBullets(value) {
  const items = Array.isArray(value) ? value : String(value || '').split('\n');
  const cleanItems = items.map((item) => stripMarkdown(item).replace(/^-\s*/, '')).filter((item) => item && !/^not recorded/i.test(item));
  return cleanItems.length ? cleanItems.map((item) => '- ' + item).join('\n') : '- ';
}

function parseLabelSection(text = '') {
  const groups = { main_labels: [], associate_labels: [], system_labels: [], sensitive_labels: [] };
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const lower = line.toLowerCase();
    if (/main labels?/.test(lower)) current = 'main_labels';
    else if (/associate labels?/.test(lower)) current = 'associate_labels';
    else if (/system labels?/.test(lower)) current = 'system_labels';
    else if (/sensitive labels?/.test(lower)) current = 'sensitive_labels';
    else if (current && /^\s*[-*]\s+/.test(line)) groups[current].push(stripMarkdown(line));
  }
  return groups;
}

function formatLabelsFromImport(raw, text = '') {
  const textLabels = parseLabelSection(text);
  const labels = raw.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels) ? raw.labels : {};
  return [
    'Main labels:', asBullets(labels.main_labels || labels.mainLabels || textLabels.main_labels), '',
    'Associate labels:', asBullets(labels.associate_labels || labels.associateLabels || textLabels.associate_labels), '',
    'System labels:', asBullets(labels.system_labels || labels.systemLabels || textLabels.system_labels), '',
    'Sensitive labels:', asBullets(labels.sensitive_labels || labels.sensitiveLabels || textLabels.sensitive_labels)
  ].join('\n');
}

function timelineRows(text = '') {
  return String(text || '').split('\n').map((line) => stripMarkdown(line)).filter(Boolean).map((line) => {
    const m = line.match(/^(.{3,45}?)(?:\s+[-??]\s+|\s{2,})(.+)$/);
    return m ? { date: m[1].trim(), title: m[2].trim(), linkedFile: '', notes: '' } : null;
  }).filter(Boolean);
}

function importedSectionMap(raw) {
  const map = new Map();
  const add = (title, content) => {
    if (!title || !String(content || '').trim()) return;
    map.set(slugSection(title), { title: String(title).trim(), content: String(content).trim() });
  };
  if (raw.template_markdown) markdownSections(raw.template_markdown).forEach((sec) => add(sec.title, sec.content));
  if (raw.source_sections && typeof raw.source_sections === 'object') Object.entries(raw.source_sections).forEach(([k, v]) => add(k, Array.isArray(v) ? v.join('\n') : v));
  if (Array.isArray(raw.sections)) raw.sections.forEach((sec) => add(sec.title || sec.id, sec.content || ''));
  if (raw.text || raw.markdown || raw.sourceText) markdownSections(raw.text || raw.markdown || raw.sourceText).forEach((sec) => add(sec.title, sec.content));
  return map;
}

function normalizeImportedProfile(raw, actor) {
  if (raw?.profile && !raw.name && !raw.master_profile) raw = raw.profile;
  if (typeof raw === 'string') raw = { text: raw };
  raw = raw || {};
  const map = importedSectionMap(raw);
  const settingsText = map.get('profile-settings')?.content || '';
  const settingsKv = keyValues(settingsText);
  const coreText = map.get('core-information')?.content || '';
  const coreKv = keyValues(coreText);
  const core = raw.core_information || raw.coreInformation || {};
  const pick = (...keys) => {
    for (const key of keys) {
      const value = core[key] ?? coreKv[key] ?? settingsKv[key] ?? raw[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
  };
  const sections = baseProfileSections().map((section) => ({ ...section }));
  const put = (id, patch) => Object.assign(sections.find((section) => section.id === id) || {}, patch);
  put('profile-settings', { content: [
    'Profile type: ' + (pick('profile_type', 'profileType', 'type') || 'master'),
    'Status: ' + (pick('status') || 'active'),
    'Classification: ' + (pick('classification') || 'workspace'),
    'Relationship type: ' + pick('relationship_type', 'relationshipType'),
    'Restricted: ' + (/yes|true/i.test(pick('restricted')) || raw.restricted === true ? 'Yes' : 'No'),
    'SRestricted: ' + (raw.srestricted === true || /yes|true/i.test(pick('srestricted', 's_restricted', 'super_restricted')) ? 'Yes' : 'No'),
    'One-line read: ' + pick('one_line_read', 'oneLineRead')
  ].join('\n'), detailLevel: 'full' });
  put('core-information', { content: [
    'Name: ' + pick('name'),
    'Date of birth: ' + pick('date_of_birth', 'dateOfBirth'),
    'Age: ' + pick('age'),
    'Current location: ' + pick('current_location', 'currentLocation')
  ].join('\n'), detailLevel: 'full' });
  put('labels', { content: formatLabelsFromImport(raw, map.get('labels')?.content || '') });
  for (const section of sections) {
    if (['profile-settings', 'core-information', 'labels', 'timeline'].includes(section.id)) continue;
    const mapped = map.get(section.id);
    if (mapped) section.content = mapped.content;
  }
  put('timeline', { content: '', entries: Array.isArray(raw.timeline) ? raw.timeline : timelineRows(map.get('timeline')?.content || '') });
  const known = new Set(sections.map((section) => section.id));
  const retained = [...map.entries()].filter(([id]) => !known.has(id)).map(([, sec]) => '### ' + sec.title + '\n\n' + sec.content);
  if (retained.length) sections.push(sectionTemplate('additional-source-sections', 'Additional source sections retained', 'text', retained.join('\n\n---\n\n'), { loadIntoMcp: false, generated: true, locked: false }));
  const restrictedValue = raw.restricted ?? settingsKv.restricted ?? core.restricted ?? coreKv.restricted;
  const srestrictedValue = raw.srestricted ?? raw.s_restricted ?? raw.super_restricted ?? settingsKv.srestricted ?? settingsKv.s_restricted;
  return {
    id: crypto.randomUUID(),
    name: clean(raw.name || raw.master_profile || core.name || coreKv.name, 120),
    type: clean(raw.type || raw.profile_type || settingsKv.profile_type || core.profile_type || 'master', 60),
    status: clean(raw.status || settingsKv.status || core.status || coreKv.status || 'active', 40),
    classification: clean(raw.classification || settingsKv.classification || core.classification || coreKv.classification || 'workspace', 120),
    restricted: restrictedValue === true || /yes|true/i.test(String(restrictedValue || '')),
    srestricted: srestrictedValue === true || /yes|true/i.test(String(srestrictedValue || '')),
    fields: raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields) ? raw.fields : {},
    sections: mergeBaseSections(sections),
    editorIds: Array.isArray(raw.editorIds) ? raw.editorIds : [],
    viewerIds: Array.isArray(raw.viewerIds) ? raw.viewerIds : [],
    createdBy: actor, createdAt: now(), updatedBy: actor, updatedAt: now(), version: 1
  };
}

export async function profileOverview(workspaceRoot, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = profilePermissions(state, role, userId);
  const profiles = state.enabled && permissions.view
    ? state.profiles.filter((profile) => canAccessProfile(profile, permissions, userId, role, systemRole)).map((profile) => sanitizeProfileLabels(profile, permissions))
    : [];
  const storage = profileStorageStats(state);
  const visibleIds = new Set(profiles.map((profile) => profile.id));
  const profileBundles = (state.profileBundles || []).map((bundle) => ({
    ...bundle,
    profileIds: (bundle.profileIds || []).filter((id) => visibleIds.has(id))
  }));
  return {
    enabled: state.enabled,
    settings: state.settings,
    permissions,
    profiles,
    profileBundles,
    profileTypes: state.profileTypes,
    slots: state.userSlots[userId] ?? { master: null, additional: null },
    roleOverrides: state.roleOverrides || {},
    memberOverrides: state.memberOverrides || {},
    statistics: {
      profilesUsed: storage.count,
      profilesAllowed: state.settings.maxProfiles,
      profileStorageBytes: storage.totalBytes,
      largestProfileBytes: storage.largestBytes,
      maxProfileSizeBytes: state.settings.maxProfileSizeBytes,
      maxTotalProfileStorageBytes: state.settings.maxTotalProfileStorageBytes,
      excludedFromWorkspaceQuota: true,
      perProfile: storage.entries
    }
  };
}

export async function profileCatalog(workspaceRoot, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = profilePermissions(state, role, userId);
  const profiles = state.enabled && permissions.view
    ? state.profiles.filter((profile) => canAccessProfile(profile, permissions, userId, role, systemRole)).map((profile) => {
        const sanitized = sanitizeProfileLabels(profile, permissions);
        const sections = mergeBaseSections(sanitized.sections);
        const labels = parseProfileLabelGroups(sections.find((section) => section.id === 'labels') || {});
        const relationships = sections.find((section) => section.id === 'relationships');
        return {
          id: sanitized.id, name: sanitized.name, type: sanitized.type, status: sanitized.status,
          classification: sanitized.classification, restricted: Boolean(sanitized.restricted),
          srestricted: Boolean(sanitized.srestricted), labels,
          relationshipCount: Array.isArray(relationships?.relationships) ? relationships.relationships.length : 0,
          sectionCount: sections.filter((section) => section?.removed !== true && section?.enabled !== false).length,
          updatedAt: sanitized.updatedAt || null
        };
      })
    : [];
  const visibleIds = new Set(profiles.map((profile) => profile.id));
  const profileBundles = (state.profileBundles || []).map((bundle) => ({
    id: bundle.id, name: bundle.name, description: bundle.description || '',
    profileIds: (bundle.profileIds || []).filter((id) => visibleIds.has(id)), updatedAt: bundle.updatedAt || null
  })).filter((bundle) => bundle.profileIds.length > 0);
  const storage = profileStorageStats(state);
  return {
    enabled: state.enabled, permissions, profiles, profileBundles,
    settings: state.settings,
    slots: state.userSlots[userId] ?? { master: null, additional: null },
    roleOverrides: state.roleOverrides || {},
    memberOverrides: state.memberOverrides || {},
    statistics: {
      profilesUsed: storage.count, profilesAllowed: state.settings.maxProfiles,
      profileStorageBytes: storage.totalBytes, largestProfileBytes: storage.largestBytes,
      maxProfileSizeBytes: state.settings.maxProfileSizeBytes,
      maxTotalProfileStorageBytes: state.settings.maxTotalProfileStorageBytes,
      excludedFromWorkspaceQuota: true, perProfile: storage.entries
    }
  };
}

export async function exportProfileState(workspaceRoot, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  requireProfilePermission(state, role, userId, 'export');
  const permissions = profilePermissions(state, role, userId);
  return {
    exportedAt: now(),
    version: state.version || 1,
    enabled: state.enabled,
    settings: state.settings,
    profileTypes: state.profileTypes || [],
    roleOverrides: state.roleOverrides || {},
    memberOverrides: state.memberOverrides || {},
    userSlots: state.userSlots || {},
    profileBundles: state.profileBundles || [],
    profiles: (state.profiles || []).filter((profile) => canAccessProfile(profile, permissions, userId, role, systemRole)).map((profile) => sanitizeProfileLabels(profile, permissions)),
    audit: state.audit || [],
    profileEditRequests: state.profileEditRequests || []
  };
}

export async function importProfileState(workspaceRoot, input, actor, role, userId) {
  const state = await readProfileState(workspaceRoot);
  const permissions = requireProfilePermission(state, role, userId, 'import');
  const payload = Array.isArray(input) ? { profiles: input } : input?.profile ? { profiles: [input.profile], replaceAll: input.replaceAll } : (input || {});
  if (!payload || typeof payload !== 'object') throw Object.assign(new Error('Import payload required'), { status: 400 });

  const failures = [];
  const importedProfiles = [];
  const importedIdMap = new Map();
  const sourceProfiles = Array.isArray(payload.profiles) ? payload.profiles : [];

  for (let index = 0; index < sourceProfiles.length; index += 1) {
    try {
      const raw = sourceProfiles[index];
      if (!raw || typeof raw !== 'object') throw new Error('Profile is not an object');
      const profile = protectNewProfileLabels(normalizeImportedProfile(raw, actor), permissions);
      if (raw.id) importedIdMap.set(String(raw.id), profile.id);
      if (!profile.name) throw new Error('Profile name is missing');
      if (!profile.fields || typeof profile.fields !== 'object' || Array.isArray(profile.fields)) {
        profile.fields = {};
        failures.push({ path: `profiles[${index}].fields`, message: 'Fields were invalid and were replaced with an empty object' });
      }
      if (!Array.isArray(profile.sections)) {
        profile.sections = [];
        failures.push({ path: `profiles[${index}].sections`, message: 'Sections were invalid and were replaced with an empty list' });
      }
      enforceProfileLimits({ ...state, profiles: [...state.profiles, ...importedProfiles] }, profile);
      importedProfiles.push(profile);
    } catch (error) {
      failures.push({ path: `profiles[${index}]`, message: error?.message || 'Profile could not be imported' });
    }
  }

  if (payload.replaceAll === true && importedProfiles.length > 0) state.profiles = [];
  state.profiles.push(...importedProfiles);

  if (payload.enabled !== undefined) state.enabled = Boolean(payload.enabled);
  if (payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)) {
    const nextSettings = { ...state.settings };
    if (['summary', 'standard', 'full'].includes(payload.settings.startupMode)) nextSettings.startupMode = payload.settings.startupMode;
    else if (payload.settings.startupMode !== undefined) failures.push({ path: 'settings.startupMode', message: 'Unsupported detail level was ignored' });
    if (payload.settings.loadUserSlots !== undefined) nextSettings.loadUserSlots = Boolean(payload.settings.loadUserSlots);
    if (Array.isArray(payload.settings.loadWorkspaceProfiles)) nextSettings.loadWorkspaceProfiles = payload.settings.loadWorkspaceProfiles.filter((id) => typeof id === 'string');
    state.settings = nextSettings;
  } else if (payload.settings !== undefined) {
    failures.push({ path: 'settings', message: 'Settings were not an object and were ignored' });
  }

  if (Array.isArray(payload.profileTypes)) state.profileTypes = payload.profileTypes;
  else if (payload.profileTypes !== undefined) failures.push({ path: 'profileTypes', message: 'Profile types were not a list and were ignored' });

  if (Array.isArray(payload.profileBundles)) {
    const valid = new Set(state.profiles.filter((profile) => !profile.deletedAt).map((profile) => profile.id));
    state.profileBundles = payload.profileBundles.filter((bundle) => bundle && typeof bundle === 'object').map((bundle) => ({
      id: clean(bundle.id, 120) || crypto.randomUUID(),
      name: clean(bundle.name, 120) || 'Imported bundle',
      description: clean(bundle.description, 500),
      profileIds: [...new Set((Array.isArray(bundle.profileIds) ? bundle.profileIds : []).map((id) => importedIdMap.get(String(id)) || clean(id, 120)).filter((id) => valid.has(id)))],
      createdBy: clean(bundle.createdBy || actor, 120), createdAt: bundle.createdAt || now(), updatedBy: actor, updatedAt: now()
    }));
  } else if (payload.profileBundles !== undefined) failures.push({ path: 'profileBundles', message: 'Profile bundles were not a list and were ignored' });

  state.audit.push({ id: crypto.randomUUID(), action: 'profiles_imported', actor, at: now(), imported: importedProfiles.length, failed: failures.length, replaceAll: payload.replaceAll === true });
  await saveProfileState(workspaceRoot, state);
  return { imported: importedProfiles.length, failed: failures.length, failures, applied: { settings: Boolean(payload.settings && typeof payload.settings === 'object'), enabled: payload.enabled !== undefined, profileTypes: Array.isArray(payload.profileTypes) } };
}

export async function setProfileSystemEnabled(workspaceRoot, enabled, actor) {
  const state = await readProfileState(workspaceRoot);
  state.enabled = Boolean(enabled);
  state.audit.push({ id: crypto.randomUUID(), action: state.enabled ? 'enabled' : 'disabled', actor, at: now() });
  return saveProfileState(workspaceRoot, state);
}

function normaliseProfileBundle(input = {}, actor = '', existing = null) {
  return {
    id: existing?.id || crypto.randomUUID(),
    name: clean(input.name ?? existing?.name, 120),
    description: clean(input.description ?? existing?.description, 500),
    profileIds: [...new Set((Array.isArray(input.profileIds) ? input.profileIds : existing?.profileIds || []).map((id) => clean(id, 120)).filter(Boolean))],
    createdBy: existing?.createdBy || actor,
    createdAt: existing?.createdAt || now(),
    updatedBy: actor,
    updatedAt: now()
  };
}
function bundleAllowedIds(state, permissions, userId, role, systemRole = 'user') {
  return new Set(state.profiles.filter((profile) => canAccessProfile(profile, permissions, userId, role, systemRole)).map((profile) => profile.id));
}
export async function createProfileBundle(workspaceRoot, input, actor, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = requireProfilePermission(state, role, userId, 'create');
  const bundle = normaliseProfileBundle(input, actor);
  if (!bundle.name) throw Object.assign(new Error('Bundle name required'), { status: 400 });
  const allowed = bundleAllowedIds(state, permissions, userId, role, systemRole);
  bundle.profileIds = bundle.profileIds.filter((id) => allowed.has(id));
  state.profileBundles.push(bundle);
  state.audit.push({ id: crypto.randomUUID(), action: 'profile_bundle_created', bundleId: bundle.id, actor, at: now() });
  await saveProfileState(workspaceRoot, state);
  return bundle;
}
export async function updateProfileBundle(workspaceRoot, bundleId, input, actor, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = requireProfilePermission(state, role, userId, 'create');
  const index = (state.profileBundles || []).findIndex((bundle) => bundle.id === bundleId);
  if (index < 0) throw Object.assign(new Error('Profile bundle not found'), { status: 404 });
  const bundle = normaliseProfileBundle(input, actor, state.profileBundles[index]);
  if (!bundle.name) throw Object.assign(new Error('Bundle name required'), { status: 400 });
  const allowed = bundleAllowedIds(state, permissions, userId, role, systemRole);
  bundle.profileIds = bundle.profileIds.filter((id) => allowed.has(id));
  state.profileBundles[index] = bundle;
  state.audit.push({ id: crypto.randomUUID(), action: 'profile_bundle_updated', bundleId, actor, at: now() });
  await saveProfileState(workspaceRoot, state);
  return bundle;
}
export async function deleteProfileBundle(workspaceRoot, bundleId, actor, role, userId) {
  const state = await readProfileState(workspaceRoot);
  requireProfilePermission(state, role, userId, 'create');
  const before = (state.profileBundles || []).length;
  state.profileBundles = (state.profileBundles || []).filter((bundle) => bundle.id !== bundleId);
  if (state.profileBundles.length === before) throw Object.assign(new Error('Profile bundle not found'), { status: 404 });
  state.audit.push({ id: crypto.randomUUID(), action: 'profile_bundle_deleted', bundleId, actor, at: now() });
  await saveProfileState(workspaceRoot, state);
  return { ok: true };
}

function relationshipSection(profile) {
  profile.sections = mergeBaseSections(profile.sections);
  return profile.sections.find((section) => section.id === 'relationships');
}
function relationshipContent(relationships = []) {
  return relationships.map((rel) => [rel.profileName || rel.profileId || 'Linked profile', rel.fromLabel || '', rel.fromDate ? 'from ' + rel.fromDate : '', rel.toDate ? 'to ' + rel.toDate : '', rel.status ? '(' + rel.status + ')' : '', rel.notes || ''].filter(Boolean).join(' — ')).join('\n');
}
function syncReverseRelationships(state, sourceProfile, actor) {
  const sourceSection = relationshipSection(sourceProfile);
  const authored = (sourceSection.relationships || []).filter((rel) => rel && !rel.syncedFromProfileId);
  sourceSection.content = relationshipContent(sourceSection.relationships || []);
  for (const target of state.profiles.filter((item) => !item.deletedAt && item.id !== sourceProfile.id)) {
    const targetSection = relationshipSection(target);
    const before = Array.isArray(targetSection.relationships) ? targetSection.relationships : [];
    const next = before.filter((item) => {
      if (item?.syncedFromProfileId !== sourceProfile.id) return true;
      const sourceRel = authored.find((rel) => rel.id === item.syncedFromRelationshipId);
      return Boolean(sourceRel && sourceRel.profileId === target.id && sourceRel.toLabel);
    });
    if (next.length !== before.length) { targetSection.relationships = next; targetSection.content = relationshipContent(next); target.updatedBy = actor; target.updatedAt = now(); }
  }
  for (const rel of authored) {
    if (!rel.profileId || !rel.toLabel) continue;
    const target = state.profiles.find((item) => item.id === rel.profileId && !item.deletedAt);
    if (!target || target.id === sourceProfile.id) continue;
    const targetSection = relationshipSection(target);
    const relationships = Array.isArray(targetSection.relationships) ? [...targetSection.relationships] : [];
    const reverseId = 'reverse:' + sourceProfile.id + ':' + rel.id;
    const reverse = { id: reverseId, profileId: sourceProfile.id, profileName: sourceProfile.name, presetId: rel.presetId || '', category: rel.category || 'Other', fromLabel: rel.toLabel, toLabel: rel.fromLabel || '', fromDate: rel.fromDate || '', toDate: rel.toDate || '', status: rel.status || 'current', notes: rel.notes || '', autoSync: true, syncedFromProfileId: sourceProfile.id, syncedFromRelationshipId: rel.id, updatedBy: actor, updatedAt: now() };
    const existingIndex = relationships.findIndex((item) => item.id === reverseId || (item.syncedFromProfileId === sourceProfile.id && item.syncedFromRelationshipId === rel.id));
    if (existingIndex >= 0) relationships[existingIndex] = { ...relationships[existingIndex], ...reverse }; else relationships.push(reverse);
    targetSection.relationships = relationships; targetSection.content = relationshipContent(relationships); target.updatedBy = actor; target.updatedAt = now();
  }
}

export async function createProfile(workspaceRoot, input, actor, role, userId) {
  const state = await readProfileState(workspaceRoot);
  if (!state.enabled) throw Object.assign(new Error('Master Profile System is disabled for this workspace'), { status: 409 });
  const permissions = requireProfilePermission(state, role, userId, 'create');
  const profile = protectNewProfileLabels(normalizeImportedProfile(input, actor), permissions);
  if (!profile.name) throw Object.assign(new Error('Profile name required'), { status: 400 });
  enforceProfileLimits(state, profile);
  state.profiles.push(profile);
  syncReverseRelationships(state, profile, actor);
  state.audit.push({ id: crypto.randomUUID(), action: 'profile_created', profileId: profile.id, actor, at: now() });
  await saveProfileState(workspaceRoot, state);
  return profile;
}

export async function updateProfile(workspaceRoot, profileId, input, actor, role, userId) {
  const state = await readProfileState(workspaceRoot);
  const profile = state.profiles.find((item) => item.id === profileId && !item.deletedAt);
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  const permissions = profilePermissions(state, role, userId);
  const assigned = profile.editorIds?.includes(userId);
  if (!(permissions.edit || (permissions.edit_assigned && assigned))) throw Object.assign(new Error('Profile edit permission required'), { status: 403 });
  if (profile.restricted && !permissions.edit_restricted) throw Object.assign(new Error('Restricted profile edit permission required'), { status: 403 });
  for (const key of ['name','type','status','classification']) if (input[key] !== undefined) profile[key] = clean(input[key], 120);
  for (const key of ['fields','editorIds','viewerIds']) if (input[key] !== undefined) profile[key] = input[key];
  if (input.sections !== undefined) profile.sections = protectLabelUpdates(profile, input.sections, permissions);
  if (input.restricted !== undefined) profile.restricted = Boolean(input.restricted);
  if (input.srestricted !== undefined) profile.srestricted = Boolean(input.srestricted);
  profile.sections = mergeBaseSections(profile.sections);
  enforceProfileLimits(state, profile, profile.id);
  syncReverseRelationships(state, profile, actor);
  profile.updatedBy = actor;
  profile.updatedAt = now();
  profile.version = Number(profile.version || 0) + 1;
  state.audit.push({ id: crypto.randomUUID(), action: 'profile_updated', profileId, actor, at: now(), version: profile.version });
  await saveProfileState(workspaceRoot, state);
  return profile;
}


const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function editableSection(profile, id) {
  profile.sections = mergeBaseSections(profile.sections);
  return profile.sections.find((section) => section.id === id);
}

function normaliseRelationshipList(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((item) => item && typeof item === 'object').map((item) => ({
    id: clean(item.id || '', 180) || crypto.randomUUID(),
    profileId: clean(item.profileId || item.linkedProfileId || item.linked_profile_id || '', 120),
    profileName: clean(item.profileName || item.linkedProfile || item.linked_profile || item.name || '', 160),
    presetId: clean(item.presetId || item.relationshipPreset || '', 80),
    category: clean(item.category || 'Other', 80),
    fromLabel: clean(item.fromLabel || item.relationshipFromThisProfile || item.from || item.relationship || '', 180),
    toLabel: clean(item.toLabel || item.relationshipShownOnLinkedProfile || item.reverse || item.reverseRelationship || '', 180),
    fromDate: clean(item.fromDate || item.startDate || item.start_date || '', 40),
    toDate: clean(item.toDate || item.endDate || item.end_date || '', 40),
    status: clean(item.status || 'current', 60),
    notes: clean(item.notes || item.briefNotes || item.brief_notes || '', 800),
    autoSync: item.autoSync !== false
  })).filter((item) => item.profileId || item.profileName || item.fromLabel || item.toLabel || item.notes);
}

function canApproveProfileEdit(permissions, role) {
  return role === 'owner' || permissions.approve_profile_commands === true;
}

export async function createProfileEditRequest(workspaceRoot, input, actor, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = profilePermissions(state, role, userId);
  if (!permissions.view) throw Object.assign(new Error('Profile view permission required'), { status: 403 });
  const profile = state.profiles.find((item) => item.id === input.profileId && !item.deletedAt);
  if (!profile || !canAccessProfile(profile, permissions, userId, role, systemRole)) throw Object.assign(new Error('Profile not found'), { status: 404 });
  const rawPatch = input.patch && typeof input.patch === 'object' && !Array.isArray(input.patch) ? input.patch : {};
  const relationships = rawPatch.relationships !== undefined ? normaliseRelationshipList(rawPatch.relationships) : undefined;
  if (rawPatch.relationships !== undefined && relationships === null) throw Object.assign(new Error('relationships patch must be a list'), { status: 400 });
  const patch = { ...rawPatch };
  if (relationships !== undefined) patch.relationships = relationships;
  const request = {
    id: crypto.randomUUID(), profileId: profile.id, profileName: profile.name,
    requestedBy: actor, requestedByUserId: userId, requestedAt: now(), status: 'pending',
    summary: clean(input.summary || input.note || 'Profile edit requested from ChatGPT', 500),
    patch, patchKeys: Object.keys(patch), baseVersion: Number(profile.version || 0), applyState: 'waiting_approval'
  };
  state.profileEditRequests = Array.isArray(state.profileEditRequests) ? state.profileEditRequests : [];
  state.profileEditRequests.push(request);
  state.audit.push({ id: crypto.randomUUID(), action: 'profile_edit_requested', profileId: profile.id, requestId: request.id, actor, at: now(), patchKeys: request.patchKeys });
  await saveProfileState(workspaceRoot, state);
  await delay(40);
  const check = await readProfileState(workspaceRoot);
  if (!check.profileEditRequests?.some((item) => item.id === request.id && item.status === 'pending')) throw Object.assign(new Error('Profile edit request was not saved; try again'), { status: 500, code: 'PROFILE_REQUEST_SAVE_FAILED' });
  return request;
}

export async function listProfileEditRequests(workspaceRoot, role, userId) {
  const state = await readProfileState(workspaceRoot);
  const permissions = profilePermissions(state, role, userId);
  if (!canApproveProfileEdit(permissions, role)) throw Object.assign(new Error('Workspace editor or owner approval required'), { status: 403 });
  return { requests: Array.isArray(state.profileEditRequests) ? state.profileEditRequests : [] };
}

export async function resolveProfileEditRequest(workspaceRoot, requestId, input, actor, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = profilePermissions(state, role, userId);
  if (!canApproveProfileEdit(permissions, role)) throw Object.assign(new Error('Workspace editor or owner approval required'), { status: 403 });
  const request = (state.profileEditRequests || []).find((item) => item.id === requestId);
  if (!request) throw Object.assign(new Error('Profile edit request not found'), { status: 404 });
  if (request.status !== 'pending') throw Object.assign(new Error('Profile edit request already resolved'), { status: 409 });
  const approve = input.approved === true || input.status === 'approved';
  const applied = { ok: false, changed: [], beforeVersion: null, afterVersion: null, verified: false };
  const profile = approve ? state.profiles.find((item) => item.id === request.profileId && !item.deletedAt) : null;
  if (approve) {
    if (!profile) throw Object.assign(new Error('Profile no longer exists'), { status: 404 });
    const privileged = role === 'owner' || systemRole === 'owner' || systemRole === 'admin';
    if (profile.srestricted && !privileged) throw Object.assign(new Error('SRestricted profile approval requires workspace owner or system admin/owner'), { status: 403 });
    if (profile.restricted && !permissions.edit_restricted) throw Object.assign(new Error('Restricted profile approval requires edit restricted permission'), { status: 403 });
    const patch = request.patch || {};
    applied.beforeVersion = Number(profile.version || 0);
    for (const key of ['name','type','status','classification']) if (patch[key] !== undefined) { profile[key] = clean(patch[key], 120); applied.changed.push(key); }
    for (const key of ['fields','editorIds','viewerIds']) if (patch[key] !== undefined) { profile[key] = patch[key]; applied.changed.push(key); }
    if (patch.sections !== undefined) { profile.sections = protectLabelUpdates(profile, patch.sections, permissions); applied.changed.push('sections'); }
    if (patch.restricted !== undefined) { profile.restricted = Boolean(patch.restricted); applied.changed.push('restricted'); }
    if (patch.srestricted !== undefined) { profile.srestricted = Boolean(patch.srestricted); applied.changed.push('srestricted'); }
    if (patch.relationships !== undefined) {
      const section = editableSection(profile, 'relationships');
      section.kind = 'relationships';
      section.relationships = normaliseRelationshipList(patch.relationships) || [];
      section.content = relationshipContent(section.relationships);
      applied.changed.push('relationships');
    }
    profile.sections = mergeBaseSections(profile.sections);
    syncReverseRelationships(state, profile, actor);
    profile.updatedBy = actor;
    profile.updatedAt = now();
    profile.version = applied.beforeVersion + 1;
    applied.afterVersion = profile.version;
    applied.ok = true;
    applied.changed = [...new Set(applied.changed)];
    if (!applied.changed.length) throw Object.assign(new Error('Approved patch had no supported changes to apply'), { status: 400, code: 'PROFILE_PATCH_EMPTY' });
  }
  request.status = approve ? 'approved' : 'rejected';
  request.resolvedBy = actor;
  request.resolvedByUserId = userId;
  request.resolvedAt = now();
  request.resolutionNote = clean(input.note || '', 500);
  request.applyState = approve ? 'applied_pending_verify' : 'rejected';
  request.applied = applied;
  state.audit.push({ id: crypto.randomUUID(), action: approve ? 'profile_edit_approved' : 'profile_edit_rejected', profileId: request.profileId, requestId, actor, at: now(), applied });
  await saveProfileState(workspaceRoot, state);
  if (approve) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await delay(75 * attempt);
      const check = await readProfileState(workspaceRoot);
      const savedProfile = check.profiles.find((item) => item.id === request.profileId && !item.deletedAt);
      const savedRequest = check.profileEditRequests?.find((item) => item.id === requestId);
      if (savedProfile && Number(savedProfile.version || 0) >= Number(applied.afterVersion || 0) && savedRequest?.status === 'approved') {
        applied.verified = true;
        request.applyState = 'applied_verified';
        break;
      }
    }
    if (!applied.verified) throw Object.assign(new Error('Profile edit was saved but verification did not complete; refresh before approving again'), { status: 500, code: 'PROFILE_APPLY_VERIFY_FAILED' });
    request.applyState = 'applied_verified';
    request.applied = applied;
    await saveProfileState(workspaceRoot, state);
  }
  return { request, applied };
}

export async function repairProfileState(workspaceRoot, actor, role, userId) {
  const state = await readProfileState(workspaceRoot);
  requireProfilePermission(state, role, userId, 'repair');
  let repaired = 0;
  const active = (state.profiles || []).filter((profile) => !profile.deletedAt);
  for (const profile of active) {
    const before = JSON.stringify(profile.sections || []);
    profile.sections = mergeBaseSections(Array.isArray(profile.sections) ? profile.sections : []);
    if (!profile.fields || typeof profile.fields !== 'object' || Array.isArray(profile.fields)) profile.fields = {};
    if (!Array.isArray(profile.editorIds)) profile.editorIds = [];
    if (!Array.isArray(profile.viewerIds)) profile.viewerIds = [];
    if (JSON.stringify(profile.sections) !== before) repaired += 1;
  }
  for (const profile of active) syncReverseRelationships(state, profile, actor);
  const valid = new Set(active.map((profile) => profile.id));
  for (const bundle of state.profileBundles || []) bundle.profileIds = [...new Set((bundle.profileIds || []).filter((id) => valid.has(id)))];
  for (const [uid, slot] of Object.entries(state.userSlots || {})) state.userSlots[uid] = { ...slot, master: valid.has(slot?.master) ? slot.master : null, additional: valid.has(slot?.additional) ? slot.additional : null };
  state.audit.push({ id: crypto.randomUUID(), action: 'profiles_repaired', actor, at: now(), repaired });
  await saveProfileState(workspaceRoot, state);
  return { ok: true, repaired, profiles: active.length };
}

export async function createProfileCommandRequest(workspaceRoot, input, actor, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = profilePermissions(state, role, userId);
  if (!permissions.queue_profile_commands) throw Object.assign(new Error('Profile command queue permission required'), { status: 403, code: 'PROFILE_QUEUE_PERMISSION_REQUIRED' });
  const command = clean(input.command, 40);
  if (!['create','edit','archive','import','repair'].includes(command)) throw Object.assign(new Error('Unsupported queued profile command'), { status: 400, code: 'INVALID_PROFILE_COMMAND' });
  const profileId = clean(input.profileId || input.payload?.profileId || '', 120);
  const profile = profileId ? state.profiles.find((item) => item.id === profileId && !item.deletedAt) : null;
  if (profileId && !profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  if (profile && !canAccessProfile(profile, permissions, userId, role, systemRole)) throw Object.assign(new Error('Profile not found'), { status: 404 });
  const request = {
    id: crypto.randomUUID(), command, profileId: profile?.id || null,
    profileName: profile?.name || clean(input.payload?.name || input.payload?.profile?.name || '',160) || command,
    requestedBy: actor, requestedByUserId: userId, requestedAt: now(), status: 'pending',
    summary: clean(input.summary || `${command} profile command requested from ChatGPT`,500),
    payload: input.payload || {}, patch: command === 'edit' ? (input.payload?.patch || input.payload || {}) : (input.payload || {}),
    patchKeys: Object.keys(input.payload || {}), baseVersion: Number(profile?.version || 0), applyState: 'waiting_approval'
  };
  state.profileEditRequests = Array.isArray(state.profileEditRequests) ? state.profileEditRequests : [];
  state.profileEditRequests.push(request);
  state.audit.push({ id: crypto.randomUUID(), action: 'profile_command_requested', command, profileId: request.profileId, requestId: request.id, actor, at: now() });
  await saveProfileState(workspaceRoot, state);
  return request;
}

export async function deleteProfile(workspaceRoot, profileId, actor, role, userId) {
  const state = await readProfileState(workspaceRoot);
  requireProfilePermission(state, role, userId, 'delete');
  const profile = state.profiles.find((item) => item.id === profileId && !item.deletedAt);
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });
  profile.deletedAt = now();
  profile.deletedBy = actor;
  for (const target of state.profiles.filter((item) => !item.deletedAt && item.id !== profileId)) {
    const section = relationshipSection(target);
    const before = Array.isArray(section.relationships) ? section.relationships : [];
    const next = before.filter((rel) => rel?.syncedFromProfileId !== profileId);
    if (next.length !== before.length) { section.relationships = next; section.content = relationshipContent(next); target.updatedBy = actor; target.updatedAt = now(); }
  }
  for (const bundle of state.profileBundles || []) bundle.profileIds = (bundle.profileIds || []).filter((id) => id !== profileId);
  state.audit.push({ id: crypto.randomUUID(), action: 'profile_deleted', profileId, actor, at: now() });
  await saveProfileState(workspaceRoot, state);
  return { ok: true };
}

export async function setUserSlots(workspaceRoot, userId, input, role) {
  const state = await readProfileState(workspaceRoot);
  requireProfilePermission(state, role, userId, 'load_context');
  const valid = new Set(state.profiles.filter((item) => !item.deletedAt).map((item) => item.id));
  const master = input.master && valid.has(input.master) ? input.master : null;
  const additional = input.additional && valid.has(input.additional) ? input.additional : null;
  state.userSlots[userId] = { master, additional, updatedAt: now() };
  await saveProfileState(workspaceRoot, state);
  return state.userSlots[userId];
}

export async function setProfilePermissions(workspaceRoot, input, actor, role, userId) {
  const state = await readProfileState(workspaceRoot);
  requireProfilePermission(state, role, userId, 'manage_permissions');
  if (input.roleOverrides && typeof input.roleOverrides === 'object') state.roleOverrides = input.roleOverrides;
  if (input.memberOverrides && typeof input.memberOverrides === 'object') state.memberOverrides = input.memberOverrides;
  state.audit.push({ id: crypto.randomUUID(), action: 'permissions_updated', actor, at: now() });
  await saveProfileState(workspaceRoot, state);
  return { roleOverrides: state.roleOverrides, memberOverrides: state.memberOverrides };
}

export async function setProfileSettings(workspaceRoot, input, actor, role, userId) {
  const state = await readProfileState(workspaceRoot);
  requireProfilePermission(state, role, userId, 'manage_startup');
  const valid = new Set(state.profiles.filter((item) => !item.deletedAt).map((item) => item.id));
  const startupMode = ['summary', 'standard', 'full'].includes(String(input.startupMode || '')) ? String(input.startupMode) : (state.settings?.startupMode || 'summary');
  const loadUserSlots = input.loadUserSlots !== undefined ? Boolean(input.loadUserSlots) : Boolean(state.settings?.loadUserSlots ?? true);
  const loadWorkspaceProfiles = Array.isArray(input.loadWorkspaceProfiles)
    ? input.loadWorkspaceProfiles.filter((id) => valid.has(id))
    : (Array.isArray(state.settings?.loadWorkspaceProfiles) ? state.settings.loadWorkspaceProfiles.filter((id) => valid.has(id)) : []);
  const maxProfiles = input.maxProfiles !== undefined ? Math.max(1, Math.min(10000, Number(input.maxProfiles) || state.settings.maxProfiles)) : state.settings.maxProfiles;
  const maxProfileSizeBytes = input.maxProfileSizeMB !== undefined ? Math.max(MiB, Math.min(10240 * MiB, Number(input.maxProfileSizeMB) * MiB || state.settings.maxProfileSizeBytes)) : state.settings.maxProfileSizeBytes;
  const maxTotalProfileStorageBytes = input.maxTotalProfileStorageMB !== undefined ? Math.max(0, Math.min(1048576 * MiB, Number(input.maxTotalProfileStorageMB) * MiB || 0)) : state.settings.maxTotalProfileStorageBytes;
  state.settings = { ...state.settings, startupMode, loadUserSlots, loadWorkspaceProfiles, maxProfiles, maxProfileSizeBytes, maxTotalProfileStorageBytes };
  const storage = profileStorageStats(state);
  if (storage.count > maxProfiles) throw Object.assign(new Error('Current profiles exceed the requested profile count limit'), { status: 409, code: 'PROFILE_COUNT_LIMIT_TOO_LOW' });
  if (storage.entries.some((entry) => entry.sizeBytes > maxProfileSizeBytes)) throw Object.assign(new Error('An existing profile exceeds the requested profile size limit'), { status: 409, code: 'PROFILE_SIZE_LIMIT_TOO_LOW' });
  if (maxTotalProfileStorageBytes > 0 && storage.totalBytes > maxTotalProfileStorageBytes) throw Object.assign(new Error('Current profile storage exceeds the requested total allowance'), { status: 409, code: 'PROFILE_STORAGE_LIMIT_TOO_LOW' });
  state.audit.push({ id: crypto.randomUUID(), action: 'settings_updated', actor, at: now(), startupMode, loadUserSlots, loadWorkspaceProfiles });
  await saveProfileState(workspaceRoot, state);
  return state.settings;
}

function contextProfiles(state, permissions, userId, role = 'viewer', systemRole = 'user') {
  const slot = state.userSlots[userId] ?? {};
  const ids = [...new Set([
    ...(state.settings?.loadUserSlots === false ? [] : [slot.master, slot.additional]),
    ...(state.settings?.loadWorkspaceProfiles ?? [])
  ].filter(Boolean))];
  return state.profiles.filter((item) => ids.includes(item.id) && canAccessProfile(item, permissions, userId, role, systemRole));
}

function presentProfileForMode(profile, mode = 'summary') {
  if (mode === 'full') return profile;
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    status: profile.status,
    classification: profile.classification,
    restricted: profile.restricted,
    fields: mode === 'standard' ? profile.fields : undefined,
    sections: mode === 'standard' ? profile.sections : undefined,
    updatedAt: profile.updatedAt
  };
}

function markdownValue(value) {
  if (Array.isArray(value)) return value.map((item) => `- ${String(item)}`).join('\n');
  if (value && typeof value === 'object') return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '').trim();
}

function sectionMarkdown(section) {
  if (section?.kind === 'relationships') {
    const relationships = Array.isArray(section.relationships) ? section.relationships : [];
    return relationships.map((rel) => `- ${rel.profileName || rel.profileId || 'Linked profile'}: ${rel.fromLabel || 'relationship'}${rel.fromDate ? ` | from ${rel.fromDate}` : ''}${rel.toDate ? ` | to ${rel.toDate}` : ''}${rel.status ? ` | ${rel.status}` : ''}${rel.notes ? ` — ${rel.notes}` : ''}`).join('\n') || '_No relationships yet_';
  }
  if (section?.kind === 'timeline') {
    const entries = Array.isArray(section.entries) ? section.entries : [];
    return entries.map((entry) => `- ${entry.date || 'No date'} ? ${entry.title || 'Untitled'}${entry.linkedFile ? ` ? ${entry.linkedFile}` : ''}${entry.notes ? ` ? ${entry.notes}` : ''}`).join('\n') || '_No timeline entries yet_';
  }
  return String(section?.content ?? '').trim() || '_No content_';
}

export function profileMarkdown(profile) {
  const lines = [
    `# ${profile.name}`,
    '',
    `- **Type:** ${profile.type}`,
    `- **Status:** ${profile.status}`,
    `- **Classification:** ${profile.classification}`,
    `- **Restricted:** ${profile.restricted ? 'Yes' : 'No'}`,
    `- **SRestricted:** ${profile.srestricted ? 'Yes' : 'No'}`
  ];
  const fields = Object.entries(profile.fields || {}).filter(([, value]) => value !== null && value !== undefined && markdownValue(value));
  if (fields.length) {
    lines.push('', '## Profile fields');
    for (const [key, value] of fields) {
      const label = key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
      lines.push('', `### ${label}`, markdownValue(value));
    }
  }
  for (const section of Array.isArray(profile.sections) ? profile.sections : []) {
    if (section?.removed === true || section?.enabled === false || section?.canRead === false || section?.loadIntoMcp === false) continue;
    const title = clean(section?.title || section?.name || 'Section', 160);
    const content = sectionMarkdown(section);
    if (!title && !content) continue;
    lines.push('', `## ${title || 'Section'}`);
    if (section?.detailLevel === 'summary' && section?.kind !== 'relationships' && section?.kind !== 'timeline') lines.push('', content.split(/\n+/).find((line) => line.trim()) || content || '_No content_');
    else lines.push('', content || '_No content_');
  }
  return lines.join('\n').trim();
}

function profileSummaryText(profile) {
  const lines = [
    `Profile: ${profile.name}`,
    `Type: ${profile.type}`,
    `Status: ${profile.status}`,
    `Classification: ${profile.classification}`
  ];
  const fieldEntries = Object.entries(profile.fields || {}).filter(([, value]) => value !== null && value !== undefined && (!Array.isArray(value) ? String(value).trim().length > 0 : value.length > 0));
  for (const [key, value] of fieldEntries.slice(0, 12)) lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
  return lines.join('\n');
}

export async function profileContext(workspaceRoot, role, userId, mode = 'summary', systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = requireProfilePermission(state, role, userId, 'load_context');
  if (!state.enabled) return { enabled: false, profiles: [] };
  const profiles = contextProfiles(state, permissions, userId, role, systemRole).map((profile) => sanitizeProfileLabels(profile, permissions));
  return { enabled: true, mode, settings: state.settings, profiles: profiles.map((profile) => presentProfileForMode(profile, mode)) };
}

export async function profileKnowledgeProjection(workspaceRoot, profileId, role, userId, systemRole = 'user', requiredPermission = 'view') {
  const state = await readProfileState(workspaceRoot);
  const permissions = requireProfilePermission(state, role, userId, requiredPermission);
  if (!state.enabled) throw Object.assign(new Error('Workspace Profiles is disabled'), { status: 503 });
  const profile = (state.profiles || []).find((entry) => String(entry.id) === String(profileId));
  if (!profile || !canAccessProfile(profile, permissions, userId, role, systemRole)) throw Object.assign(new Error('Profile is not accessible'), { status: 404 });
  const sanitized = sanitizeProfileLabels(profile, permissions);
  return { profile: sanitized, permissions: { viewRestricted: permissions.view_restricted === true, loadContext: permissions.load_context === true }, projection: { userId, role, systemRole, profileId: sanitized.id, updatedAt: sanitized.updatedAt || null } };
}

export async function profileModule(workspaceRoot, role, userId, systemRole = 'user') {
  const state = await readProfileState(workspaceRoot);
  const permissions = requireProfilePermission(state, role, userId, 'load_context');
  if (!state.enabled) return { enabled: false, module: null, profiles: [] };
  const mode = state.settings?.startupMode || 'summary';
  const profiles = contextProfiles(state, permissions, userId, role, systemRole).map((profile) => sanitizeProfileLabels(profile, permissions));
  return {
    enabled: true,
    module: {
      id: 'master_profiles_system',
      kind: 'workspace_module',
      mode,
      translatedFromPanel: true,
      settings: state.settings,
      counts: { profiles: profiles.length },
      loadedProfileIds: profiles.map((profile) => profile.id),
      summary: profiles.map((profile) => profileSummaryText(profile)).join('\n\n---\n\n'),
      markdown: profiles.map((profile) => profileMarkdown(profile)).join('\n\n---\n\n'),
      profiles: profiles.map((profile) => ({
        id: profile.id, name: profile.name, type: profile.type, status: profile.status,
        classification: profile.classification, restricted: profile.restricted, srestricted: profile.srestricted,
        markdown: profileMarkdown(profile),
        fields: mode !== 'summary' ? profile.fields : undefined,
        sections: mode !== 'summary' ? profile.sections : undefined,
        updatedAt: profile.updatedAt
      }))
    },
    profiles: profiles.map((profile) => presentProfileForMode(profile, mode))
  };
}
