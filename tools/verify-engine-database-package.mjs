import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const archivePath = process.argv[2];
const expectedCommit = String(process.argv[3] || '').trim();
if (!archivePath || !/^[a-f0-9]{40}$/.test(expectedCommit)) {
  throw new Error('Usage: node tools/verify-engine-database-package.mjs <artifact.gz> <source-commit>');
}
const payload = JSON.parse(gunzipSync(readFileSync(archivePath)).toString('utf8'));
if (payload.format !== 'orbitfs-update-bundle-v3' || payload.sourceCommit !== expectedCommit) {
  throw new Error('Update bundle format/source commit mismatch');
}
const componentSet = new Set(payload.components || []);
if (['mcp', 'apex', 'studio'].some(component => !componentSet.has(component))) {
  throw new Error('Initial-install validation package must include all Engine components');
}
const engine = payload.payloads?.engine;
if (!engine || engine.sourceCommit !== expectedCommit) {
  throw new Error('Update bundle is missing its matching Engine payload');
}
const database = payload.database;
if (database?.format !== 'orbitfs-db-migrations-v1' ||
    database?.mode !== 'shared-panel' ||
    database?.provider !== 'supabase' ||
    !Array.isArray(database.migrations) ||
    database.migrations.length < 1 ||
    database.migrationCount !== database.migrations.length ||
    JSON.stringify(engine.database) !== JSON.stringify(database)) {
  throw new Error('Update bundle database contract is missing or differs from its Engine payload');
}
const ids = new Set();
const components = new Set();
let total = 0;
for (const migration of database.migrations) {
  const match = String(migration.file || '').match(/^supabase\/migrations\/(shared|apex|mcp|studio)\/(\d{14}_[A-Za-z0-9._-]+)\.sql$/);
  if (!match || migration.component !== match[1] ||
      migration.id !== match[1] + '.' + match[2] ||
      ids.has(migration.id) || migration.encoding !== 'base64') {
    throw new Error('Invalid or duplicate component migration identity: ' + migration.id);
  }
  ids.add(migration.id);
  components.add(migration.component);
  const bytes = Buffer.from(migration.data, 'base64');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024 ||
      bytes.length !== migration.size || hash !== migration.sha256) {
    throw new Error('Component migration integrity mismatch: ' + migration.id);
  }
  total += bytes.length;
}
if (!components.has('shared') || !components.has('mcp') || total > 8 * 1024 * 1024) {
  throw new Error('Initial Engine migration manifest lacks expected shared/MCP contract or exceeds limits');
}
console.log(JSON.stringify({ ok: true, sourceCommit: expectedCommit, components: [...componentSet],
  migrationCount: database.migrations.length, migrationComponents: [...components], bytes: total }));
