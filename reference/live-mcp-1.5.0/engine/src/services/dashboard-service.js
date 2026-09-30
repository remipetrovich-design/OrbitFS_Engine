import { listSessions } from './session-registry-service.js';

function summarizeContext(receipt) {
  if (!receipt) return {
    active: false,
    contextId: null,
    preset: null,
    presetDisplayName: null,
    files: 0,
    characters: 0,
    failed: 0,
    truncated: 0,
    updatedAt: null
  };
  return {
    active: true,
    contextId: receipt.contextId || null,
    preset: receipt.preset || receipt.strength || null,
    presetDisplayName: receipt.presetDisplayName || receipt.preset || receipt.strength || null,
    files: Number(receipt.transferredCount || receipt.files?.length || 0),
    characters: Number(receipt.charactersTransferred || 0),
    failed: Number(receipt.failedCount || 0),
    truncated: Number(receipt.truncatedCount || 0),
    updatedAt: receipt.updatedAt || receipt.completedAt || null
  };
}

export function buildDashboardSnapshot({ workspaceId, workspace = null, identity = {}, config = null, activeContext = null, changeStatus = null, license = null, sessionIdleMinutes = 60 } = {}) {
  const context = summarizeContext(activeContext);
  const sessions = listSessions({ workspaceId, includeInactive: true, idleMinutes: sessionIdleMinutes });
  return {
    workspace: workspace ? {
      id: workspace.id,
      name: workspace.name || workspace.id,
      status: workspace.status || 'active',
      role: identity.role || 'user'
    } : null,
    user: {
      id: identity.userId || null,
      username: identity.username || 'Unknown user',
      systemRole: identity.role || 'user'
    },
    license: license ? {
      licensed: license.licensed === true,
      reason: license.reason || null,
      lastCheckedAt: license.lastCheckedAt || null
    } : { licensed: false, reason: 'unknown', lastCheckedAt: null },
    context,
    startup: {
      preset: config?.strength || null,
      presetDisplayName: config?.presetDisplayName || config?.presetMetadata?.[config?.strength]?.displayName || config?.strength || null,
      projectName: config?.project?.name || null,
      defaultItemCount: Number(config?.defaultItems?.length || 0),
      presetItemCount: Number(config?.presetItems?.length || 0)
    },
    connections: {
      active: sessions.filter((session) => session.status === 'active' && !session.idle).length,
      total: sessions.length,
      sessions
    },
    alerts: [
      ...(changeStatus?.outdated ? [{ type: 'context_outdated', severity: 'warning', message: `${changeStatus.changedFiles?.length || 0} loaded source files changed.` }] : []),
      ...(context.failed ? [{ type: 'context_failures', severity: 'warning', message: `${context.failed} context items failed to load.` }] : [])
    ]
  };
}
