const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function idleCutoff(idleMinutes) {
  return Date.now() - Math.max(1, Number(idleMinutes || 60)) * 60 * 1000;
}

function isIdle(session, idleMinutes) {
  return Date.parse(session.lastSeenAt) < idleCutoff(idleMinutes);
}

function activeClientSessionCount(clientId, idleMinutes, excludeSessionId = null) {
  return [...sessions.values()].filter((session) =>
    session.id !== excludeSessionId &&
    session.clientId === clientId &&
    session.status === 'active' &&
    !isIdle(session, idleMinutes)
  ).length;
}

export function touchSession({ sessionId, clientId, identity = {}, workspaceId = null,
  conversationId = null, provider = 'chatgpt', maxActiveSessionsPerClient = 10,
  idleMinutes = 60 } = {}) {
  if (!clientId) throw Object.assign(new Error('clientId is required'), { status: 400, code: 'CLIENT_ID_REQUIRED' });
  const id = String(sessionId || clientId);
  const current = sessions.get(id) || null;
  if (current?.status === 'blocked') {
    throw Object.assign(new Error('This MCP session was disconnected by an administrator'), { status: 403, code: 'SESSION_BLOCKED' });
  }
  if (!current && activeClientSessionCount(clientId, idleMinutes) >= Number(maxActiveSessionsPerClient || 10)) {
    throw Object.assign(new Error(`Active MCP session limit reached for this client (${maxActiveSessionsPerClient})`), {
      status: 429, code: 'SESSION_LIMIT_REACHED'
    });
  }
  const timestamp = nowIso();
  const next = {
    id, clientId,
    userId: identity.userId || current?.userId || null,
    username: identity.username || current?.username || 'Unknown user',
    systemRole: identity.role || current?.systemRole || 'user',
    workspaceId: workspaceId || current?.workspaceId || null,
    conversationId: conversationId || current?.conversationId || null,
    provider,
    connectedAt: current?.connectedAt || timestamp,
    lastSeenAt: timestamp,
    status: current?.status === 'blocked' ? 'blocked' : 'active',
    requestCount: Number(current?.requestCount || 0) + 1
  };
  sessions.set(id, next);
  return { ...next, idle: false };
}

export function updateSessionWorkspace(sessionId, workspaceId, options = {}) {
  const current = sessions.get(sessionId);
  if (!current) return null;
  return touchSession({
    sessionId,
    clientId: current.clientId,
    identity: current,
    workspaceId,
    conversationId: current.conversationId,
    provider: current.provider,
    ...options
  });
}

export function listSessions({ workspaceId = null, clientId = null,
  includeInactive = false, idleMinutes = 60 } = {}) {
  return [...sessions.values()]
    .map((session) => ({ ...session, idle: isIdle(session, idleMinutes) }))
    .filter((session) => !workspaceId || session.workspaceId === workspaceId)
    .filter((session) => !clientId || session.clientId === clientId)
    .filter((session) => includeInactive || (!session.idle && session.status === 'active'))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

export function disconnectSession(sessionId, reason = 'admin_disconnect') {
  const current = sessions.get(sessionId);
  if (!current) return null;
  const next = { ...current, status: 'blocked', disconnectReason: reason,
    disconnectedAt: nowIso(), lastSeenAt: nowIso() };
  sessions.set(sessionId, next);
  return { ...next, idle: false };
}

export function unblockSession(sessionId) {
  const current = sessions.get(sessionId);
  if (!current) return null;
  const next = { ...current, status: 'active', lastSeenAt: nowIso() };
  delete next.disconnectReason;
  delete next.disconnectedAt;
  sessions.set(sessionId, next);
  return { ...next, idle: false };
}

export function disconnectClientSessions(clientId, reason = 'admin_disconnect') {
  const disconnected = [];
  for (const session of [...sessions.values()]) {
    if (session.clientId !== clientId) continue;
    const next = disconnectSession(session.id, reason);
    if (next) disconnected.push(next);
  }
  return disconnected;
}

export function removeSession(sessionId) {
  const current = sessions.get(sessionId) || null;
  sessions.delete(sessionId);
  return current;
}
