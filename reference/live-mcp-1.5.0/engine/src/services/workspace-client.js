const DEFAULT_PANEL_BASE_URL = 'http://127.0.0.1:8400/api';

function panelBaseUrl() {
  return String(process.env.ORBITFS_PANEL_BASE_URL || DEFAULT_PANEL_BASE_URL).replace(/\/+$/, '');
}

function authHeaders(identity = {}) {
  const headers = { 'content-type': 'application/json' };
  const controlToken = process.env.ORBITFS_CONTROL_TOKEN || process.env.ORBITFS_PANEL_TOKEN;
  if (controlToken) headers.authorization = `Bearer ${controlToken}`;
  if (identity.userId) headers['x-orbitfs-user-id'] = String(identity.userId);
  if (identity.username) headers['x-orbitfs-username'] = String(identity.username);
  if (identity.role) headers['x-orbitfs-user-role'] = String(identity.role);
  return headers;
}

export function profileApiPath(workspaceId, suffix = '') {
  return `/internal/addons/mcp/workspaces/${encodeURIComponent(workspaceId)}/profiles${suffix}`;
}

export async function callWorkspaceApi(identity, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${panelBaseUrl()}${path}`, { method, headers: authHeaders(identity), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw Object.assign(new Error(data?.error || data?.message || `Base Panel API failed with ${response.status}`), { status: response.status, code: data?.code || 'BASE_PANEL_API_FAILED', details: data });
  return data;
}

export async function callWorkspaceRawApi(identity, path, { method = 'POST', body, headers = {} } = {}) {
  const requestHeaders = { ...authHeaders(identity), ...headers };
  if (!headers['content-type'] && !headers['Content-Type']) delete requestHeaders['content-type'];
  const response = await fetch(`${panelBaseUrl()}${path}`, { method, headers: requestHeaders, body });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw Object.assign(new Error(data?.error || data?.message || `Base Panel API failed with ${response.status}`), { status: response.status, code: data?.code || 'BASE_PANEL_API_FAILED', details: data });
  return data;
}
