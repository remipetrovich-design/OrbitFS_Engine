import mysql from "mysql2/promise";

let pool;
function db() {
  pool ??= mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "orbitfs",
    waitForConnections: true,
    connectionLimit: 5,
    charset: "utf8mb4"
  });
  return pool;
}

export async function ensureContextLibrarySchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS mcp_audit_log (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, scope_id VARCHAR(120) NOT NULL DEFAULT 'public',
      actor_user_id VARCHAR(120) NULL, event_type VARCHAR(80) NOT NULL, details JSON NULL,
      created_at DATETIME(3) NOT NULL, INDEX idx_mcp_audit_scope(scope_id,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS mcp_context_bundles (
      id CHAR(36) PRIMARY KEY, workspace_id VARCHAR(120) NOT NULL,
      name VARCHAR(160) NOT NULL, description VARCHAR(1000) NOT NULL DEFAULT '',
      enabled TINYINT(1) NOT NULL DEFAULT 1, version INT NOT NULL DEFAULT 1,
      created_by_user_id VARCHAR(120) NULL, created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_mcp_bundle_name (workspace_id,name),
      INDEX idx_mcp_bundles_workspace (workspace_id,enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS mcp_context_bundle_entries (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      bundle_id CHAR(36) NOT NULL, entry_type ENUM('file','folder','knowledge') NOT NULL,
      item_path TEXT NOT NULL,
      attachment_type ENUM('path','profile','knowledge') NOT NULL DEFAULT 'path',
      profile_id VARCHAR(120) NULL, profile_name VARCHAR(160) NULL,
      knowledge_item_id VARCHAR(160) NULL, knowledge_item_name VARCHAR(180) NULL, load_mode VARCHAR(24) NULL,
      recursive_flag TINYINT(1) NOT NULL DEFAULT 1,
      required_flag TINYINT(1) NOT NULL DEFAULT 1, priority INT NOT NULL DEFAULT 100,
      sort_order INT NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL,
      CONSTRAINT fk_mcp_bundle_entries_bundle FOREIGN KEY (bundle_id)
        REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
      INDEX idx_mcp_bundle_entries (bundle_id,priority,sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS mcp_context_bundle_dependencies (
      bundle_id CHAR(36) NOT NULL, depends_on_bundle_id CHAR(36) NOT NULL,
      required_flag TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (bundle_id,depends_on_bundle_id),
      CONSTRAINT fk_mcp_bundle_dep_parent FOREIGN KEY (bundle_id)
        REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
      CONSTRAINT fk_mcp_bundle_dep_child FOREIGN KEY (depends_on_bundle_id)
        REFERENCES mcp_context_bundles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS mcp_workspace_preset_bundles (
      workspace_id VARCHAR(120) NOT NULL,
      preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
      bundle_id CHAR(36) NOT NULL, required_flag TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (workspace_id,preset,bundle_id),
      CONSTRAINT fk_mcp_preset_bundle FOREIGN KEY (bundle_id)
        REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
      INDEX idx_mcp_preset_bundles (workspace_id,preset,sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS mcp_project_preset_bundles (
      project_id CHAR(36) NOT NULL,
      preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
      bundle_id CHAR(36) NOT NULL, required_flag TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (project_id,preset,bundle_id),
      CONSTRAINT fk_mcp_project_preset_bundle_project FOREIGN KEY (project_id)
        REFERENCES mcp_projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_mcp_project_preset_bundle_bundle FOREIGN KEY (bundle_id)
        REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
      INDEX idx_mcp_project_preset_bundles (project_id,preset,sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS mcp_project_context_bundles (
      project_id CHAR(36) NOT NULL, bundle_id CHAR(36) NOT NULL,
      required_flag TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (project_id,bundle_id),
      CONSTRAINT fk_mcp_project_bundle_project FOREIGN KEY (project_id) REFERENCES mcp_projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_mcp_project_bundle_bundle FOREIGN KEY (bundle_id) REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
      INDEX idx_mcp_project_bundles (project_id,sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  ];
  for (const sql of statements) await db().query(sql);
  const [entryColumns] = await db().query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mcp_context_bundle_entries'`
  );
  const existingEntryColumns = new Set(entryColumns.map((column) => column.COLUMN_NAME));
  if (!existingEntryColumns.has('attachment_type')) {
    await db().query("ALTER TABLE mcp_context_bundle_entries ADD COLUMN attachment_type ENUM('path','profile') NOT NULL DEFAULT 'path' AFTER item_path");
  }
  if (!existingEntryColumns.has('profile_id')) {
    await db().query('ALTER TABLE mcp_context_bundle_entries ADD COLUMN profile_id VARCHAR(120) NULL AFTER attachment_type');
  }
  if (!existingEntryColumns.has('profile_name')) {
    await db().query('ALTER TABLE mcp_context_bundle_entries ADD COLUMN profile_name VARCHAR(160) NULL AFTER profile_id');
  }
  if (!existingEntryColumns.has('knowledge_item_id')) await db().query('ALTER TABLE mcp_context_bundle_entries ADD COLUMN knowledge_item_id VARCHAR(160) NULL AFTER profile_name');
  if (!existingEntryColumns.has('knowledge_item_name')) await db().query('ALTER TABLE mcp_context_bundle_entries ADD COLUMN knowledge_item_name VARCHAR(180) NULL AFTER knowledge_item_id');
  if (!existingEntryColumns.has('load_mode')) await db().query('ALTER TABLE mcp_context_bundle_entries ADD COLUMN load_mode VARCHAR(24) NULL AFTER knowledge_item_name');
  await db().query("ALTER TABLE mcp_context_bundle_entries MODIFY attachment_type ENUM('path','profile','knowledge') NOT NULL DEFAULT 'path'");
  await db().query("ALTER TABLE mcp_context_bundle_entries MODIFY entry_type ENUM('file','folder','knowledge') NOT NULL");
  await ensurePresetMetadataSchema();
}

export async function ensurePresetMetadataSchema() {
  await db().query(`CREATE TABLE IF NOT EXISTS mcp_workspace_preset_metadata (
    workspace_id VARCHAR(120) NOT NULL,
    preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
    display_name VARCHAR(80) NOT NULL DEFAULT '',
    updated_by_user_id VARCHAR(120) NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(workspace_id,preset),
    INDEX idx_mcp_preset_metadata_workspace(workspace_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db().query(`CREATE TABLE IF NOT EXISTS mcp_project_preset_metadata (
    project_id CHAR(36) NOT NULL,
    preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
    display_name VARCHAR(80) NOT NULL DEFAULT '',
    updated_by_user_id VARCHAR(120) NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(project_id,preset),
    CONSTRAINT fk_mcp_project_preset_metadata_project FOREIGN KEY (project_id)
      REFERENCES mcp_projects(id) ON DELETE CASCADE,
    INDEX idx_mcp_project_preset_metadata_project(project_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

export async function listContextBundles(workspaceId) {
  const [rows] = await db().query(
    `SELECT b.id,b.workspace_id,b.name,b.description,b.enabled,b.version,b.updated_at,
      (SELECT COUNT(*) FROM mcp_context_bundle_entries e WHERE e.bundle_id=b.id) entry_count,
      (SELECT COUNT(*) FROM mcp_context_bundle_entries e WHERE e.bundle_id=b.id AND e.attachment_type='path') path_entry_count,
      (SELECT COUNT(*) FROM mcp_context_bundle_entries e WHERE e.bundle_id=b.id AND e.attachment_type='profile') profile_entry_count,
      (SELECT COUNT(*) FROM mcp_context_bundle_entries e WHERE e.bundle_id=b.id AND e.attachment_type='knowledge') knowledge_entry_count,
      (SELECT COUNT(*) FROM mcp_context_bundle_dependencies d WHERE d.bundle_id=b.id) dependency_count
     FROM mcp_context_bundles b WHERE b.workspace_id=? ORDER BY b.name`, [workspaceId]
  );
  return rows.map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    entryCount: Number(row.entry_count || 0),
    pathEntryCount: Number(row.path_entry_count || 0),
    profileEntryCount: Number(row.profile_entry_count || 0),
    knowledgeEntryCount: Number(row.knowledge_entry_count || 0),
    dependencyCount: Number(row.dependency_count || 0)
  }));
}

export async function getContextBundle(workspaceId, bundleId) {
  const [[bundle]] = await db().query(
    `SELECT id,workspace_id,name,description,enabled,version,updated_at
     FROM mcp_context_bundles WHERE id=? AND workspace_id=?`, [bundleId, workspaceId]
  );
  if (!bundle) throw Object.assign(new Error("Context bundle not found"), { status: 404, code: "BUNDLE_NOT_FOUND" });
  const [entries] = await db().query(
    `SELECT id,entry_type,item_path,attachment_type,profile_id,profile_name,knowledge_item_id,knowledge_item_name,load_mode,
      recursive_flag,required_flag,priority,sort_order
     FROM mcp_context_bundle_entries WHERE bundle_id=? ORDER BY priority DESC,sort_order,id`, [bundleId]
  );
  const [dependencies] = await db().query(
    `SELECT d.depends_on_bundle_id,d.required_flag,d.sort_order,b.name,b.enabled
     FROM mcp_context_bundle_dependencies d
     JOIN mcp_context_bundles b ON b.id=d.depends_on_bundle_id
     WHERE d.bundle_id=? ORDER BY d.sort_order,b.name`, [bundleId]
  );
  return {
    ...bundle,
    enabled: Boolean(bundle.enabled),
    entries: entries.map((entry) => ({
      id: entry.id, type: entry.entry_type, path: entry.item_path,
      attachmentType: entry.attachment_type || 'path',
      profileId: entry.profile_id || null, profileName: entry.profile_name || null,
      knowledgeItemId: entry.knowledge_item_id || null, knowledgeItemName: entry.knowledge_item_name || null, loadMode: entry.load_mode || null,
      recursive: Boolean(entry.recursive_flag), required: Boolean(entry.required_flag),
      priority: Number(entry.priority), sortOrder: Number(entry.sort_order)
    })),
    dependencies: dependencies.map((dep) => ({
      bundleId: dep.depends_on_bundle_id, name: dep.name,
      required: Boolean(dep.required_flag), enabled: Boolean(dep.enabled),
      sortOrder: Number(dep.sort_order)
    }))
  };
}

export async function resolveContextBundle(workspaceId, bundleId) {
  const ordered = [], visiting = new Set(), visited = new Set();
  async function visit(id, requiredByParent = true) {
    if (visiting.has(id)) throw Object.assign(new Error("Context bundle dependency loop detected"), { status: 409, code: "BUNDLE_DEPENDENCY_LOOP" });
    if (visited.has(id)) return;
    visiting.add(id);
    const bundle = await getContextBundle(workspaceId, id);
    if (!bundle.enabled) {
      if (requiredByParent) throw Object.assign(new Error(`Required context bundle is disabled: ${bundle.name}`), { status: 409, code: "BUNDLE_DISABLED" });
      visiting.delete(id); return;
    }
    for (const dependency of bundle.dependencies) {
      try { await visit(dependency.bundleId, dependency.required); }
      catch (error) { if (dependency.required) throw error; }
    }
    visiting.delete(id); visited.add(id); ordered.push(bundle);
  }
  await visit(bundleId, true);
  const entries = [];
  for (const bundle of ordered) for (const entry of bundle.entries) entries.push({ ...entry, bundleId: bundle.id, bundleName: bundle.name });
  return { rootBundleId: bundleId, bundles: ordered, entries };
}

export async function createContextBundle({ workspaceId, id, name, description = '', enabled = true, userId = null }) {
  const now = new Date();
  await db().query(
    `INSERT INTO mcp_context_bundles
      (id,workspace_id,name,description,enabled,version,created_by_user_id,created_at,updated_at)
     VALUES (?,?,?,?,?,1,?,?,?)`,
    [id, workspaceId, String(name).trim(), description, enabled ? 1 : 0, userId, now, now]
  );
  return getContextBundle(workspaceId, id);
}

async function validateBundleDependencies(connection, workspaceId, bundleId, dependencies, maxDependencyDepth = Number.POSITIVE_INFINITY) {
  const dependencyIds = [...new Set(dependencies.map((item) => String(item.bundleId || '')).filter(Boolean))];
  if (dependencyIds.includes(bundleId)) {
    throw Object.assign(new Error('A bundle cannot depend on itself'), { status: 409, code: 'BUNDLE_SELF_DEPENDENCY' });
  }
  if (dependencyIds.length) {
    const [targets] = await connection.query(
      'SELECT id FROM mcp_context_bundles WHERE workspace_id=? AND id IN (?)',
      [workspaceId, dependencyIds]
    );
    if (targets.length !== dependencyIds.length) {
      throw Object.assign(new Error('A dependency is missing or belongs to another workspace'), { status: 409, code: 'BUNDLE_DEPENDENCY_INVALID' });
    }
  }
  const [rows] = await connection.query(
    `SELECT d.bundle_id,d.depends_on_bundle_id
     FROM mcp_context_bundle_dependencies d
     JOIN mcp_context_bundles b ON b.id=d.bundle_id
     WHERE b.workspace_id=? AND d.bundle_id<>?`,
    [workspaceId, bundleId]
  );
  const graph = new Map();
  for (const row of rows) {
    if (!graph.has(row.bundle_id)) graph.set(row.bundle_id, []);
    graph.get(row.bundle_id).push(row.depends_on_bundle_id);
  }
  graph.set(bundleId, dependencyIds);
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw Object.assign(new Error('Context bundle dependency loop detected'), { status: 409, code: 'BUNDLE_DEPENDENCY_LOOP' });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) || []) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  visit(bundleId);
  const depthMemo = new Map();
  function depth(id) {
    if (depthMemo.has(id)) return depthMemo.get(id);
    const children = graph.get(id) || [];
    const value = children.length ? 1 + Math.max(...children.map(depth)) : 0;
    depthMemo.set(id, value);
    return value;
  }
  const dependencyDepth = depth(bundleId);
  if (Number.isFinite(maxDependencyDepth) && dependencyDepth > maxDependencyDepth) {
    throw Object.assign(new Error(`Context bundle dependency depth ${dependencyDepth} exceeds limit ${maxDependencyDepth}`), { status: 409, code: 'CCS_DEPENDENCY_DEPTH_LIMIT' });
  }
}

export async function saveContextBundle({ workspaceId, bundleId, name, description = '', enabled = true, entries = [], dependencies = [], maxDependencyDepth = Number.POSITIVE_INFINITY }) {
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    const [updated] = await connection.query(
      `UPDATE mcp_context_bundles SET name=?,description=?,enabled=?,version=version+1,updated_at=?
       WHERE id=? AND workspace_id=?`,
      [String(name).trim(), description, enabled ? 1 : 0, new Date(), bundleId, workspaceId]
    );
    if (!updated.affectedRows) throw Object.assign(new Error('Context bundle not found'), { status: 404, code: 'BUNDLE_NOT_FOUND' });
    await validateBundleDependencies(connection, workspaceId, bundleId, dependencies, Number(maxDependencyDepth));
    await connection.query('DELETE FROM mcp_context_bundle_entries WHERE bundle_id=?', [bundleId]);
    await connection.query('DELETE FROM mcp_context_bundle_dependencies WHERE bundle_id=?', [bundleId]);
    const now = new Date();
    const normalizedEntries = [];
    const seenEntries = new Set();
    for (const rawEntry of entries) {
      const attachmentType = rawEntry?.attachmentType === 'knowledge' ? 'knowledge' : (rawEntry?.attachmentType === 'profile' ? 'profile' : 'path');
      const type = attachmentType === 'knowledge' ? 'knowledge' : (rawEntry?.type === 'folder' ? 'folder' : 'file');
      const pathValue = String(rawEntry?.path || '').trim();
      const profileId = String(rawEntry?.profileId || '').trim();
      const knowledgeItemId = String(rawEntry?.knowledgeItemId || '').trim();
      if (attachmentType === 'knowledge' && !knowledgeItemId) throw Object.assign(new Error('Library bundle entries require a Knowledge Item ID'), { status:400, code:'CCS_KNOWLEDGE_ID_REQUIRED' });
      if (attachmentType === 'profile' && !profileId) throw Object.assign(new Error('Profile bundle entries require a Profile ID'), { status:400, code:'CCS_PROFILE_ID_REQUIRED' });
      if (attachmentType === 'path' && !pathValue) throw Object.assign(new Error('File/folder bundle entries require a path'), { status:400, code:'CCS_PATH_REQUIRED' });
      const key = attachmentType === 'knowledge' ? `knowledge:${knowledgeItemId}` : attachmentType === 'profile' ? `profile:${profileId}` : `path:${type}:${pathValue.toLowerCase()}`;
      if (seenEntries.has(key)) continue;
      seenEntries.add(key);
      const loadMode = attachmentType === 'knowledge' && ['smart','full','summary'].includes(String(rawEntry?.loadMode || '').trim()) ? String(rawEntry.loadMode).trim() : (attachmentType === 'knowledge' ? 'smart' : null);
      normalizedEntries.push({ ...rawEntry, attachmentType, type, path:pathValue, profileId, knowledgeItemId, loadMode });
    }
    for (const [index, entry] of normalizedEntries.entries()) {
      await connection.query(
        `INSERT INTO mcp_context_bundle_entries
          (bundle_id,entry_type,item_path,attachment_type,profile_id,profile_name,knowledge_item_id,knowledge_item_name,load_mode,
           recursive_flag,required_flag,priority,sort_order,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          bundleId,
          entry.attachmentType === 'knowledge' ? 'knowledge' : (entry.type === 'folder' ? 'folder' : 'file'),
          String(entry.path || '').trim(),
          entry.attachmentType === 'knowledge' ? 'knowledge' : (entry.attachmentType === 'profile' ? 'profile' : 'path'),
          entry.attachmentType === 'profile' ? String(entry.profileId || '').trim() || null : null,
          entry.attachmentType === 'profile' ? String(entry.profileName || '').trim() || null : null,
          entry.attachmentType === 'knowledge' ? String(entry.knowledgeItemId || '').trim() || null : null,
          entry.attachmentType === 'knowledge' ? String(entry.knowledgeItemName || '').trim() || null : null,
          entry.attachmentType === 'knowledge' ? String(entry.loadMode || '').trim() || null : null,
          entry.recursive !== false ? 1 : 0,
          entry.required !== false ? 1 : 0,
          Number(entry.priority ?? 100),
          index,
          now
        ]
      );
    }
    for (const [index, dependency] of dependencies.entries()) {
      await connection.query(
        `INSERT INTO mcp_context_bundle_dependencies
          (bundle_id,depends_on_bundle_id,required_flag,sort_order,created_at)
         VALUES (?,?,?,?,?)`,
        [bundleId, dependency.bundleId, dependency.required !== false ? 1 : 0, index, now]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return getContextBundle(workspaceId, bundleId);
}

export async function deleteContextBundle(workspaceId, bundleId) {
  const [result] = await db().query('DELETE FROM mcp_context_bundles WHERE id=? AND workspace_id=?', [bundleId, workspaceId]);
  return result.affectedRows > 0;
}

export async function getPresetBundleAssignments(workspaceId, projectId = null) {
  let rows = [];
  if (projectId) {
    const [[project]] = await db().query('SELECT id FROM mcp_projects WHERE id=? AND workspace_id=?', [projectId, workspaceId]);
    if (project) {
      [rows] = await db().query(
        `SELECT p.preset,p.bundle_id,p.required_flag,p.sort_order,b.name,b.enabled
         FROM mcp_project_preset_bundles p
         JOIN mcp_context_bundles b ON b.id=p.bundle_id
         WHERE p.project_id=? ORDER BY p.preset,p.sort_order,b.name`, [projectId]
      );
    }
  } else {
    [rows] = await db().query(
      `SELECT p.preset,p.bundle_id,p.required_flag,p.sort_order,b.name,b.enabled
       FROM mcp_workspace_preset_bundles p
       JOIN mcp_context_bundles b ON b.id=p.bundle_id
       WHERE p.workspace_id=? ORDER BY p.preset,p.sort_order,b.name`, [workspaceId]
    );
  }
  const result = Object.fromEntries(['low','medium','high','custom1','custom2'].map((key) => [key, []]));
  for (const row of rows) result[row.preset].push({
    bundleId: row.bundle_id, name: row.name, required: Boolean(row.required_flag),
    enabled: Boolean(row.enabled), sortOrder: Number(row.sort_order)
  });
  return result;
}

export async function savePresetBundleAssignments(workspaceId, assignments = {}, projectId = null) {
  if (projectId) {
    const [[project]] = await db().query('SELECT id FROM mcp_projects WHERE id=? AND workspace_id=?', [projectId, workspaceId]);
    if (!project) throw Object.assign(new Error('Project not found'), { status: 404, code: 'PROJECT_NOT_FOUND' });
  }
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    if (projectId) await connection.query('DELETE FROM mcp_project_preset_bundles WHERE project_id=?', [projectId]);
    else await connection.query('DELETE FROM mcp_workspace_preset_bundles WHERE workspace_id=?', [workspaceId]);
    const now = new Date();
    for (const preset of ['low','medium','high','custom1','custom2']) {
      for (const [index, item] of (Array.isArray(assignments[preset]) ? assignments[preset] : []).entries()) {
        if (projectId) {
          await connection.query(
            `INSERT INTO mcp_project_preset_bundles
              (project_id,preset,bundle_id,required_flag,sort_order,created_at)
             VALUES (?,?,?,?,?,?)`,
            [projectId, preset, item.bundleId, item.required !== false ? 1 : 0, index, now]
          );
        } else {
          await connection.query(
            `INSERT INTO mcp_workspace_preset_bundles
              (workspace_id,preset,bundle_id,required_flag,sort_order,created_at)
             VALUES (?,?,?,?,?,?)`,
            [workspaceId, preset, item.bundleId, item.required !== false ? 1 : 0, index, now]
          );
        }
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback(); throw error;
  } finally { connection.release(); }
  return getPresetBundleAssignments(workspaceId, projectId);
}

const PRESET_KEYS = ['low','medium','high','custom1','custom2'];
const DEFAULT_PRESET_NAMES = { low: 'Low', medium: 'Medium', high: 'High', custom1: 'Custom 1', custom2: 'Custom 2' };
const BLOCKED_PRESET_NAME_TERMS = [
  'nigger','nigga','faggot','retard','kike','chink','spic','coon','wetback',
  'kill yourself','rape','nazi','hitler','terrorist','isis'
];

export function normalizePresetDisplayName(value, fallback = '') {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (!name) return fallback;
  if (name.length > 40) throw Object.assign(new Error('Preset name must be 40 characters or less'), { status: 400, code: 'PRESET_NAME_TOO_LONG' });
  const lower = name.toLowerCase();
  if (BLOCKED_PRESET_NAME_TERMS.some((term) => lower.includes(term))) {
    throw Object.assign(new Error('Preset name is not allowed'), { status: 400, code: 'PRESET_NAME_REJECTED' });
  }
  return name;
}

export async function getPresetMetadata(workspaceId, projectId = null) {
  await ensurePresetMetadataSchema();
  let byPreset = {};
  if (projectId) {
    const [[project]] = await db().query('SELECT id FROM mcp_projects WHERE id=? AND workspace_id=?', [projectId, workspaceId]);
    if (project) {
      const [projectRows] = await db().query(
        'SELECT preset,display_name,updated_by_user_id,updated_at FROM mcp_project_preset_metadata WHERE project_id=?',
        [projectId]
      );
      for (const row of projectRows) byPreset[row.preset] = row;
    }
  } else {
    const [rows] = await db().query(
      'SELECT preset,display_name,updated_by_user_id,updated_at FROM mcp_workspace_preset_metadata WHERE workspace_id=?',
      [workspaceId]
    );
    byPreset = Object.fromEntries(rows.map((row) => [row.preset, row]));
  }
  return Object.fromEntries(PRESET_KEYS.map((preset) => [preset, {
    preset,
    displayName: byPreset[preset]?.display_name || DEFAULT_PRESET_NAMES[preset],
    defaultDisplayName: DEFAULT_PRESET_NAMES[preset],
    updatedByUserId: byPreset[preset]?.updated_by_user_id || null,
    updatedAt: byPreset[preset]?.updated_at || null
  }]));
}

export async function savePresetMetadata(workspaceId, metadata = {}, userId = null, projectId = null) {
  await ensurePresetMetadataSchema();
  const before = await getPresetMetadata(workspaceId, projectId);
  if (projectId) {
    const [[project]] = await db().query('SELECT id,name FROM mcp_projects WHERE id=? AND workspace_id=?', [projectId, workspaceId]);
    if (!project) throw Object.assign(new Error('Project not found'), { status: 404, code: 'PROJECT_NOT_FOUND' });
  }
  const changes = [];
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    const now = new Date();
    for (const preset of PRESET_KEYS) {
      const current = typeof metadata[preset] === 'object' && metadata[preset] !== null
        ? metadata[preset].displayName
        : metadata[preset];
      const oldName = before[preset]?.displayName || DEFAULT_PRESET_NAMES[preset];
      const displayName = normalizePresetDisplayName(current, DEFAULT_PRESET_NAMES[preset]);
      if (projectId) {
        await connection.query(
          `INSERT INTO mcp_project_preset_metadata
            (project_id,preset,display_name,updated_by_user_id,updated_at)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),updated_by_user_id=VALUES(updated_by_user_id),updated_at=VALUES(updated_at)`,
          [projectId, preset, displayName, userId, now]
        );
      } else {
        await connection.query(
          `INSERT INTO mcp_workspace_preset_metadata
            (workspace_id,preset,display_name,updated_by_user_id,updated_at)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),updated_by_user_id=VALUES(updated_by_user_id),updated_at=VALUES(updated_at)`,
          [workspaceId, preset, displayName, userId, now]
        );
      }
      if (displayName !== oldName) {
        changes.push({ preset, oldName, newName: displayName });
        await connection.query(
          `INSERT INTO mcp_audit_log (scope_id,actor_user_id,event_type,details,created_at)
           VALUES (?,?,?,?,?)`,
          [workspaceId, userId, 'preset_name_changed', JSON.stringify({ workspaceId, projectId: projectId || null, preset, oldName, newName: displayName }), now]
        );
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  const next = await getPresetMetadata(workspaceId, projectId);
  Object.defineProperty(next, '_changes', { value: changes, enumerable: false });
  return next;
}

export async function getProjectBundleAssignments(workspaceId, projectId) {
  const [rows] = await db().query(
    `SELECT p.bundle_id,p.required_flag,p.sort_order,b.name,b.enabled
     FROM mcp_project_context_bundles p
     JOIN mcp_context_bundles b ON b.id=p.bundle_id
     JOIN mcp_projects project ON project.id=p.project_id
     WHERE p.project_id=? AND project.workspace_id=? ORDER BY p.sort_order,b.name`, [projectId, workspaceId]
  );
  return rows.map((row) => ({ bundleId: row.bundle_id, name: row.name, required: Boolean(row.required_flag), enabled: Boolean(row.enabled), sortOrder: Number(row.sort_order) }));
}

export async function saveProjectBundleAssignments(workspaceId, projectId, assignments = []) {
  const [[project]] = await db().query('SELECT id FROM mcp_projects WHERE id=? AND workspace_id=?', [projectId, workspaceId]);
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404, code: 'PROJECT_NOT_FOUND' });
  const connection = await db().getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM mcp_project_context_bundles WHERE project_id=?', [projectId]);
    const now = new Date();
    for (const [index, item] of assignments.entries()) {
      await connection.query(
        `INSERT INTO mcp_project_context_bundles
          (project_id,bundle_id,required_flag,sort_order,created_at) VALUES (?,?,?,?,?)`,
        [projectId, item.bundleId, item.required !== false ? 1 : 0, index, now]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback(); throw error;
  } finally { connection.release(); }
  return getProjectBundleAssignments(workspaceId, projectId);
}

export async function resolveAssignedBundles(workspaceId, preset, projectId = null) {
  const presetAssignments = (await getPresetBundleAssignments(workspaceId, projectId))[preset] || [];
  const projectAssignments = projectId ? await getProjectBundleAssignments(workspaceId, projectId) : [];
  const assignments = [...projectAssignments, ...presetAssignments];
  const seen = new Set(), bundles = [], entries = [], loads = [];
  for (const assignment of assignments) {
    if (seen.has(assignment.bundleId)) continue;
    seen.add(assignment.bundleId);
    try {
      const resolved = await resolveContextBundle(workspaceId, assignment.bundleId);
      for (const bundle of resolved.bundles) if (!bundles.some((item) => item.id === bundle.id)) bundles.push(bundle);
      entries.push(...resolved.entries);
      loads.push({
        rootBundleId: assignment.bundleId,
        bundleIds: resolved.bundles.map((item) => item.id),
        bundleNames: resolved.bundles.map((item) => item.name)
      });
    } catch (error) {
      if (assignment.required) throw error;
    }
  }
  return { assignments, bundles, entries, loads };
}

export async function getDefaultProfileSelections(workspaceId) {
  const [profiles] = await db().query("SELECT profile_id FROM mcp_workspace_default_profiles WHERE workspace_id=? ORDER BY sort_order,id", [workspaceId]);
  const [groups] = await db().query("SELECT profile_bundle_id FROM mcp_workspace_default_profile_bundles WHERE workspace_id=? ORDER BY sort_order,id", [workspaceId]);
  return { profileIds: profiles.map((row) => String(row.profile_id)), profileBundleIds: groups.map((row) => String(row.profile_bundle_id)) };
}

export async function saveDefaultProfileSelections(workspaceId, profileIds = [], profileBundleIds = []) {
  const cleanProfiles = [...new Set((Array.isArray(profileIds) ? profileIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const cleanGroups = [...new Set((Array.isArray(profileBundleIds) ? profileBundleIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM mcp_workspace_default_profiles WHERE workspace_id=?", [workspaceId]);
    await conn.query("DELETE FROM mcp_workspace_default_profile_bundles WHERE workspace_id=?", [workspaceId]);
    for (const [sortOrder, profileId] of cleanProfiles.entries()) await conn.query("INSERT INTO mcp_workspace_default_profiles (workspace_id,profile_id,sort_order,created_at) VALUES (?,?,?,NOW(3))", [workspaceId, profileId, sortOrder]);
    for (const [sortOrder, groupId] of cleanGroups.entries()) await conn.query("INSERT INTO mcp_workspace_default_profile_bundles (workspace_id,profile_bundle_id,sort_order,created_at) VALUES (?,?,?,NOW(3))", [workspaceId, groupId, sortOrder]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  return getDefaultProfileSelections(workspaceId);
}
