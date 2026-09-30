import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const issuer = String(process.env.ORBITFS_MCP_ISSUER || 'https://mcp.orbitfs.cc/mcp/oauth').replace(/\/$/, '');
const resource = String(process.env.ORBITFS_MCP_RESOURCE || 'https://mcp.orbitfs.cc/mcp');
const statePath = path.resolve(process.env.ORBITFS_MCP_OAUTH_STATE || path.join(here, '..', 'data', 'oauth-state.json'));
const panelStatePath = path.resolve(process.env.ORBITFS_PANEL_STATE_PATH || path.join(here, '..', '..', '..', '..', 'panel-backend', 'data', 'state.json'));
const scopesSupported = ['orbitfs:read', 'orbitfs:write', 'offline_access'];

const now = () => Date.now();
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${random(6)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  try {
    await fs.rename(temp, file);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM','EACCES','EEXIST'].includes(error?.code)) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
    const data = await fs.readFile(temp);
    await fs.writeFile(file, data);
    await fs.unlink(temp).catch(() => {});
  }
}
async function loadState() {
  const state = await readJson(statePath, { clients: {}, codes: {}, tokens: {}, refreshTokens: {} });
  let changed = false;
  for (const bucketName of ['tokens', 'refreshTokens']) {
    const bucket = state[bucketName] || (state[bucketName] = {});
    for (const [key, value] of Object.entries(bucket)) {
      if (/^[A-Za-z0-9_-]{43}$/.test(key)) continue;
      const hashedKey = hash(key);
      if (!bucket[hashedKey]) bucket[hashedKey] = value;
      delete bucket[key];
      changed = true;
    }
  }
  if (changed) await writeJson(statePath, state);
  return state;
}
async function saveState(state) {
  const cutoff = now();
  for (const [key, value] of Object.entries(state.codes || {})) if (value.expiresAt <= cutoff) delete state.codes[key];
  for (const [key, value] of Object.entries(state.tokens || {})) if (value.expiresAt <= cutoff) delete state.tokens[key];
  for (const [key, value] of Object.entries(state.refreshTokens || {})) if (value.expiresAt <= cutoff) delete state.refreshTokens[key];
  await writeJson(statePath, state);
}

function normalizeScopes(value) {
  const requested = String(value || 'orbitfs:read orbitfs:write').split(/\s+/).filter(Boolean);
  return [...new Set(requested.filter((scope) => scopesSupported.includes(scope)))];
}
function validateRedirect(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw Object.assign(new Error('redirect_uri must use HTTPS'), { status: 400, code: 'invalid_redirect_uri' });
  }
  return parsed.toString();
}
function workspaceMembers(panel, workspaceId) {
  const value = panel.members?.[workspaceId];
  return Array.isArray(value) ? value : value ? [value] : [];
}
export function workspaceIdsFor(panel, user) {
  const ids = new Set();
  for (const workspace of panel.workspaces || []) {
    if (workspace.status !== 'active' || workspace.mcp_system_enabled === false || workspace.mcp_ui_enabled !== true) continue;
    const member = workspaceMembers(panel, workspace.id).find((item) => item.user_id === user.id);
    const rawRole = workspace.owner_id === user.id ? 'owner' : (member?.permission || (workspace.is_public ? 'viewer' : null));
    const role = rawRole === 'user' ? 'contributor' : rawRole;
    const defaults = { owner: true, editor: true, contributor: true, viewer: false };
    const override = panel.managementPermissionOverrides?.[workspace.id]?.[role]?.mcp_use;
    const systemAuthority = ['owner', 'admin'].includes(String(user.role || '').toLowerCase());
    const roleAllowsMcp = systemAuthority || (typeof override === 'boolean' ? override : defaults[role] === true);
    const belongs = workspace.owner_id === user.id || Boolean(member) || workspace.is_public;
    if (belongs && roleAllowsMcp && member?.mcp_enabled !== false) ids.add(workspace.id);
  }
  return [...ids];
}
export function workspaceCapabilitiesFor(panel, user, workspaceId) {
  const workspace = (panel.workspaces || []).find((item) => item.id === workspaceId);
  if (!workspace) return {};
  const member = workspaceMembers(panel, workspaceId).find((item) => item.user_id === user.id);
  const systemAuthority = ['owner','admin'].includes(String(user.role || '').toLowerCase());
  const rawRole = systemAuthority || workspace.owner_id === user.id ? 'owner' : (member?.permission || (workspace.is_public ? 'viewer' : null));
  const role = rawRole === 'user' ? 'contributor' : rawRole;
  const defaults = { owner:true, editor:true, contributor:true, viewer:false };
  const names = ['ventmode_use','ventmode_configure','ventmode_read','ventmode_load','ventmode_create','ventmode_draft','ventmode_upload','ventmode_discard','ventmode_read_others','ventmode_manage_others'];
  const overrides = panel.managementPermissionOverrides?.[workspaceId]?.[role] || {};
  return Object.fromEntries(names.map((name) => {
    if (name === 'ventmode_configure' || name === 'ventmode_read_others' || name === 'ventmode_manage_others') return [name, systemAuthority || role === 'owner'];
    return [name, systemAuthority || (typeof overrides[name] === 'boolean' ? overrides[name] : defaults[role] === true)];
  }));
}

export function effectiveWorkspaceIds(panel, record) {
  const user = (panel.users || []).find((item) => item.id === record.userId);
  if (!user || user.status === 'banned' || user.status === 'inactive') return { user, workspaceIds: [], revokedWorkspaceIds: [...new Set(record.workspaceIds || [])] };
  const workspaceIds = workspaceIdsFor(panel, user);
  const currentlyAllowed = new Set(workspaceIds);
  const revokedWorkspaceIds = (record.workspaceIds || []).filter((workspaceId) => !currentlyAllowed.has(workspaceId));
  return { user, workspaceIds, revokedWorkspaceIds };
}
export function oauthMetadata() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: scopesSupported
  };
}
export function oidcMetadata() {
  return { ...oauthMetadata(), jwks_uri: `${issuer}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['none'] };
}
export function protectedResourceMetadata() {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: scopesSupported,
    resource_name: 'OrbitFS MCP'
  };
}
export function authChallenge(scopes = scopesSupported, error = null, description = null) {
  const requested = Array.isArray(scopes) ? scopes.filter((scope) => scopesSupported.includes(scope)) : normalizeScopes(scopes);
  const escape = (value) => String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const params = [
    `resource_metadata="${new URL(resource).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname.replace(/\/$/, '')}"`,
    `scope="${escape((requested.length ? requested : ['orbitfs:read']).join(' '))}"`
  ];
  if (error) params.push(`error="${escape(error)}"`);
  if (description) params.push(`error_description="${escape(description)}"`);
  return `Bearer ${params.join(', ')}`;
}

export async function registerClient(body = {}) {
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(validateRedirect) : [];
  if (!redirectUris.length) throw Object.assign(new Error('redirect_uris is required'), { status: 400, code: 'invalid_client_metadata' });
  const state = await loadState();
  const clientId = `ofs_${random(24)}`;
  state.clients[clientId] = {
    clientId,
    clientName: String(body.client_name || 'MCP Client').slice(0, 160),
    redirectUris,
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
    status: 'active',
    permissions: { read: true, write: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSeenAt: null
  };
  await saveState(state);
  return {
    client_id: clientId,
    client_name: state.clients[clientId].clientName,
    redirect_uris: redirectUris,
    grant_types: state.clients[clientId].grantTypes,
    response_types: state.clients[clientId].responseTypes,
    token_endpoint_auth_method: 'none'
  };
}
function authorizationError(res, redirectUri, error, state, description) {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (description) target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return res.redirect(target.toString());
}

export async function beginAuthorization(req, res) {
  const clientId = String(req.query.client_id || '');
  const redirectUri = String(req.query.redirect_uri || '');
  const responseType = String(req.query.response_type || '');
  const codeChallenge = String(req.query.code_challenge || '');
  const codeChallengeMethod = String(req.query.code_challenge_method || '');
  const requestedResource = String(req.query.resource || '');
  const stateValue = String(req.query.state || '');
  const store = await loadState();
  const client = store.clients[clientId];
  if (!client || !client.redirectUris.includes(redirectUri)) return res.status(400).send('Invalid OAuth client or redirect URI.');
  if (client.status === 'blocked' || client.status === 'revoked') return res.status(403).send('This MCP client is blocked or revoked.');
  if (responseType !== 'code' || codeChallengeMethod !== 'S256' || !codeChallenge) {
    return authorizationError(res, redirectUri, 'invalid_request', stateValue, 'Authorization code with PKCE S256 is required.');
  }
  if (requestedResource && requestedResource !== resource) {
    return authorizationError(res, redirectUri, 'invalid_target', stateValue, 'Invalid resource.');
  }
  const scopes = normalizeScopes(req.query.scope);
  const hidden = { client_id: clientId, redirect_uri: redirectUri, state: stateValue, scope: scopes.join(' '), code_challenge: codeChallenge, resource };
  const fields = Object.entries(hidden).map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`).join('');
  res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Authorize OrbitFS</title><style>body{font-family:system-ui;background:#090b10;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(420px,90vw);background:#11151d;border:1px solid #29303d;border-radius:16px;padding:24px}input,button{box-sizing:border-box;width:100%;margin-top:12px;padding:12px;border-radius:9px;border:1px solid #364052;background:#0b0e14;color:#fff}button{background:#2563eb;border:0;font-weight:700}.muted{color:#9aa4b2;font-size:14px}</style></head><body><form method="post" class="card"><h2>Connect ${escapeHtml(client.clientName)}</h2><p class="muted">Sign in to OrbitFS and allow access to your permitted workspaces.</p>${fields}<input name="username" placeholder="OrbitFS username" autocomplete="username" required><input type="password" name="pin" placeholder="PIN" autocomplete="current-password" required><button type="submit">Authorize</button></form></body></html>`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
export async function completeAuthorization(req, res) {
  const clientId = String(req.body.client_id || '');
  const redirectUri = String(req.body.redirect_uri || '');
  const stateValue = String(req.body.state || '');
  const codeChallenge = String(req.body.code_challenge || '');
  const requestedResource = String(req.body.resource || '');
  const store = await loadState();
  const client = store.clients[clientId];
  if (!client || !client.redirectUris.includes(redirectUri)) return res.status(400).send('Invalid OAuth client.');
  if (requestedResource !== resource || !codeChallenge) return authorizationError(res, redirectUri, 'invalid_request', stateValue, 'Invalid authorization request.');

  const panel = await readJson(panelStatePath, null);
  if (!panel || !Array.isArray(panel.users)) {
    console.error('[oauth] Panel user store unavailable:', panelStatePath);
    return res.status(503).type('html').send('<h2>OrbitFS login unavailable</h2><p>The main panel account service could not be reached. Please try again shortly.</p>');
  }
  const username = String(req.body.username || '').trim();
  const pin = String(req.body.pin || '');
  const user = panel.users.find((item) => String(item?.username || '').toLowerCase() === username.toLowerCase() && String(item?.pin ?? '') === pin);
  if (!user || user.status === 'banned' || user.status === 'inactive') {
    return res.status(401).type('html').send('<h2>Authorization failed</h2><p>Invalid OrbitFS account or PIN.</p>');
  }
  const workspaceIds = workspaceIdsFor(panel, user);
  if (!workspaceIds.length) {
    return authorizationError(res, redirectUri, 'access_denied', stateValue, 'MCP access is disabled or revoked for this account.');
  }
  const code = random(32);
  store.codes[hash(code)] = {
    clientId,
    redirectUri,
    codeChallenge,
    resource,
    scopes: normalizeScopes(req.body.scope),
    userId: user.id,
    username: user.username,
    role: user.role,
    workspaceIds,
    revokedWorkspaceIds: [],
    expiresAt: now() + 5 * 60 * 1000
  };
  await saveState(store);
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (stateValue) target.searchParams.set('state', stateValue);
  return res.redirect(target.toString());
}

function issueTokens(store, record) {
  const accessToken = random(48);
  const refreshToken = random(48);
  const issuedAt = now();
  const identity = { userId: record.userId, username: record.username, role: record.role, workspaceIds: record.workspaceIds, revokedWorkspaceIds: record.revokedWorkspaceIds || [] };
  store.tokens[hash(accessToken)] = { ...identity, clientId: record.clientId, scopes: record.scopes, resource, expiresAt: issuedAt + 60 * 60 * 1000 };
  store.refreshTokens[hash(refreshToken)] = { ...identity, clientId: record.clientId, scopes: record.scopes, resource, expiresAt: issuedAt + 30 * 24 * 60 * 60 * 1000 };
  return { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: refreshToken, scope: record.scopes.join(' ') };
}
export async function tokenEndpoint(req, res) {
  const grantType = String(req.body.grant_type || '');
  const clientId = String(req.body.client_id || '');
  const requestedResource = String(req.body.resource || '');
  const store = await loadState();
  const client = store.clients[clientId];
  if (!client || client.status === 'blocked' || client.status === 'revoked') return res.status(401).json({ error: 'invalid_client' });
  client.status = 'active';
  client.lastSeenAt = new Date().toISOString();
  client.updatedAt = client.lastSeenAt;
  if (requestedResource && requestedResource !== resource) return res.status(400).json({ error: 'invalid_target' });

  if (grantType === 'authorization_code') {
    const codeKey = hash(String(req.body.code || ''));
    const record = store.codes[codeKey];
    if (!record || record.clientId !== clientId || record.redirectUri !== String(req.body.redirect_uri || '') || record.expiresAt <= now()) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const verifier = String(req.body.code_verifier || '');
    if (!verifier) return res.status(400).json({ error: 'invalid_grant' });
    const computedChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!safeEqual(computedChallenge, record.codeChallenge)) return res.status(400).json({ error: 'invalid_grant' });
    delete store.codes[codeKey];
    const result = issueTokens(store, record);
    await saveState(store);
    return res.json(result);
  }
  if (grantType === 'refresh_token') {
    const refreshKey = hash(String(req.body.refresh_token || ''));
    const record = store.refreshTokens[refreshKey];
    if (!record || record.clientId !== clientId || record.expiresAt <= now()) return res.status(400).json({ error: 'invalid_grant' });
    const panel = await readJson(panelStatePath, { users: [], workspaces: [], members: {} });
    const access = effectiveWorkspaceIds(panel, record);
    delete store.refreshTokens[refreshKey];
    if (!access.workspaceIds.length) {
      await saveState(store);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'MCP access was revoked. Reconnect OrbitFS to continue.' });
    }
    const result = issueTokens(store, { ...record, workspaceIds: access.workspaceIds, revokedWorkspaceIds: access.revokedWorkspaceIds });
    await saveState(store);
    return res.json(result);
  }
  return res.status(400).json({ error: 'unsupported_grant_type' });
}

export async function refreshOAuthIdentity(identity) {
  const panel = await readJson(panelStatePath, { users: [], workspaces: [], members: {} });
  const user = (panel.users || []).find((item) => item.id === identity.userId);
  if (!user || user.status === 'banned' || user.status === 'inactive') {
    throw Object.assign(new Error('OrbitFS account is unavailable'), { status: 403, code: 'ACCOUNT_UNAVAILABLE' });
  }
  const workspaceIds = workspaceIdsFor(panel, user);
  return { ...identity, username: user.username, role: user.role, workspaceIds };
}

export async function synchronizeOAuthAccess() {
  const [store, panel] = await Promise.all([
    loadState(), readJson(panelStatePath, { users: [], workspaces: [], members: {} })
  ]);
  let updated = 0, revoked = 0;
  for (const collectionName of ['tokens', 'refreshTokens']) {
    for (const [key, record] of Object.entries(store[collectionName] || {})) {
      const user = (panel.users || []).find((item) => item.id === record.userId);
      const workspaceIds = user && user.status !== 'banned' && user.status !== 'inactive'
        ? workspaceIdsFor(panel, user) : [];
      if (!user || !workspaceIds.length) {
        delete store[collectionName][key]; revoked += 1; continue;
      }
      store[collectionName][key] = {
        ...record, username: user.username, role: user.role,
        workspaceIds, revokedWorkspaceIds: []
      };
      updated += 1;
    }
  }
  await saveState(store);
  return { updated, revoked };
}

export async function listOAuthClients() {
  const state = await loadState();
  const tokenRecords = [...Object.values(state.tokens || {}), ...Object.values(state.refreshTokens || {})];
  return Object.values(state.clients || {}).map((client) => {
    const records = tokenRecords.filter((record) => record.clientId === client.clientId);
    return {
      ...client,
      status: client.status || 'active',
      permissions: client.permissions || { read: true, write: true },
      activeTokens: records.filter((record) => record.expiresAt > now()).length,
      users: [...new Set(records.map((record) => record.username).filter(Boolean))],
      workspaceIds: [...new Set(records.flatMap((record) => record.workspaceIds || []))]
    };
  }).sort((a, b) => Date.parse(b.lastSeenAt || b.createdAt || 0) - Date.parse(a.lastSeenAt || a.createdAt || 0));
}

function revokeClientTokens(state, clientId) {
  let revoked = 0;
  for (const collectionName of ['codes', 'tokens', 'refreshTokens']) {
    for (const [key, record] of Object.entries(state[collectionName] || {})) {
      if (record.clientId === clientId) { delete state[collectionName][key]; revoked += 1; }
    }
  }
  return revoked;
}

export async function updateOAuthClient(clientId, patch = {}) {
  const state = await loadState();
  const client = state.clients?.[clientId];
  if (!client) throw Object.assign(new Error('MCP client not found'), { status: 404, code: 'CLIENT_NOT_FOUND' });
  const status = ['active', 'blocked', 'revoked', 'disconnected'].includes(patch.status) ? patch.status : (client.status || 'active');
  client.status = status;
  if (typeof patch.clientName === 'string' && patch.clientName.trim()) client.clientName = patch.clientName.trim().slice(0, 160);
  if (patch.permissions && typeof patch.permissions === 'object') {
    client.permissions = { read: patch.permissions.read !== false, write: patch.permissions.write !== false };
  }
  client.updatedAt = new Date().toISOString();
  const revokedTokens = status === 'active' ? 0 : revokeClientTokens(state, clientId);
  await saveState(state);
  return { client: { ...client }, revokedTokens };
}

export async function revokeOAuthClientSessions(clientId) {
  const state = await loadState();
  if (!state.clients?.[clientId]) throw Object.assign(new Error('MCP client not found'), { status: 404, code: 'CLIENT_NOT_FOUND' });
  const revokedTokens = revokeClientTokens(state, clientId);
  state.clients[clientId].updatedAt = new Date().toISOString();
  await saveState(state);
  return { clientId, revokedTokens };
}

export async function bearerIdentity(req) {
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  const store = await loadState();
  const tokenKey = hash(token);
  const record = store.tokens[tokenKey];
  if (!record || record.expiresAt <= now() || record.resource !== resource) return null;
  const client = store.clients?.[record.clientId];
  if (!client || client.status === 'blocked' || client.status === 'revoked') return null;
  const permissions = client.permissions || { read: true, write: true };
  if (permissions.read === false) return null;
  record.clientPermissions = permissions;
  client.lastSeenAt = new Date().toISOString();
  const panel = await readJson(panelStatePath, { users: [], workspaces: [], members: {} });
  const access = effectiveWorkspaceIds(panel, record);
  const changed = JSON.stringify(access.revokedWorkspaceIds) !== JSON.stringify(record.revokedWorkspaceIds || []);
  if (changed) {
    store.tokens[tokenKey] = { ...record, revokedWorkspaceIds: access.revokedWorkspaceIds };
    await saveState(store);
  }
  if (!access.workspaceIds.length) return null;
  const workspaceCapabilities = Object.fromEntries(access.workspaceIds.map((workspaceId) => [workspaceId, workspaceCapabilitiesFor(panel, access.user, workspaceId)]));
  return { userId: record.userId, username: access.user.username, role: access.user.role, workspaceIds: access.workspaceIds, workspaceCapabilities, scopes: record.scopes, oauth: true, clientId: record.clientId, clientPermissions: permissions };
}

export const oauthConfig = { issuer, resource, scopesSupported, statePath, panelStatePath };
