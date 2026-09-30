import { callWorkspaceApi, profileApiPath } from './workspace-client.js';

const OPERATIONS = new Set(['add', 'append', 'replace', 'correct', 'remove', 'move', 'merge', 'mark_outdated']);

function cleanOperation(value) {
  const operation = String(value || '').trim().toLowerCase();
  if (!OPERATIONS.has(operation)) {
    throw Object.assign(new Error(`Unsupported profile edit operation: ${operation || 'missing'}`), { status: 400, code: 'INVALID_PROFILE_EDIT_OPERATION' });
  }
  return operation;
}

function buildEditPayload(input, identity, clientId) {
  const operation = cleanOperation(input.operation);
  return {
    profileId: input.profileId,
    sectionId: input.sectionId || null,
    fieldId: input.fieldId || null,
    operation,
    value: input.value ?? null,
    previousValue: input.previousValue ?? null,
    targetSectionId: input.targetSectionId || null,
    reason: input.reason || `Profile ${operation} requested through OrbitFS MCP`,
    source: {
      channel: 'mcp',
      clientId,
      userId: identity?.userId || null,
      username: identity?.username || null
    }
  };
}
export async function submitProfileEdit(identity, clientId, input) {
  if (!input?.workspaceId) throw Object.assign(new Error('workspaceId is required'), { status: 400, code: 'WORKSPACE_ID_REQUIRED' });
  if (!input?.profileId) throw Object.assign(new Error('profileId is required'), { status: 400, code: 'PROFILE_ID_REQUIRED' });
  const payload = buildEditPayload(input, identity, clientId);
  const result = await callWorkspaceApi(identity, profileApiPath(input.workspaceId, '/edit-requests'), {
    method: 'POST',
    body: payload
  });
  return {
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    operation: payload.operation,
    status: result.status || result.request?.status || 'queued',
    applied: result.applied === true || result.status === 'auto_applied',
    request: result.request || null,
    resolved: result.resolved || null,
    raw: result
  };
}

export async function saveProfileChanges(identity, clientId, input, { direct = false } = {}) {
  if (!input?.workspaceId) throw Object.assign(new Error('workspaceId is required'), { status: 400, code: 'WORKSPACE_ID_REQUIRED' });
  if (!input?.profileId) throw Object.assign(new Error('profileId is required'), { status: 400, code: 'PROFILE_ID_REQUIRED' });
  const patch = input.profilePatch && typeof input.profilePatch === 'object' && !Array.isArray(input.profilePatch)
    ? input.profilePatch
    : input.patch && typeof input.patch === 'object' && !Array.isArray(input.patch)
      ? input.patch
      : {};
  if (!Object.keys(patch).length) throw Object.assign(new Error('profilePatch is required'), { status: 400, code: 'PROFILE_PATCH_REQUIRED' });
  if (direct) {
    const result = await callWorkspaceApi(identity, profileApiPath(input.workspaceId, `/${encodeURIComponent(input.profileId)}`), {
      method: 'PATCH',
      body: patch
    });
    return {
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      status: 'saved',
      applied: true,
      profile: result.profile || null,
      raw: result
    };
  }
  const result = await callWorkspaceApi(identity, profileApiPath(input.workspaceId, '/edit-requests'), {
    method: 'POST',
    body: {
      profileId: input.profileId,
      patch,
      summary: input.summary || input.reason || 'Profile changes requested from ChatGPT',
      source: {
        channel: 'mcp',
        clientId,
        userId: identity?.userId || null,
        username: identity?.username || null
      }
    }
  });
  return {
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    status: result.status || result.request?.status || 'queued',
    applied: false,
    request: result.request || null,
    raw: result
  };
}
