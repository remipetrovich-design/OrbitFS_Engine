import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const UPDATE_COMPONENTS = new Set(['apex', 'mcp', 'studio']);
const MAX_MIGRATION_BYTES = 2 * 1024 * 1024;
const MAX_DATABASE_BYTES = 8 * 1024 * 1024;
const LEGACY_FLAT_MIGRATIONS = new Set([
	'supabase/migrations/20260908_engine_hot_path_optimizations.sql',
	'supabase/migrations/20260908_normalize_context_library_storage.sql'
]);
function isLegacyFlatMigration(path) {
	return LEGACY_FLAT_MIGRATIONS.has(normalizePath(path));
}

function normalizePath(value) {
	return String(value || '').replaceAll('\\', '/');
}

function parseMigrationPath(file) {
	const path = normalizePath(file);
	const match = path.match(/^supabase\/migrations\/(shared|base|apex|mcp|studio)\/(\d{14}_[A-Za-z0-9._-]+)\.sql$/);
	if (!match) return null;
	return { path, component: match[1], stem: match[2], id: match[1] + '.' + match[2] };
}

function collectSqlFiles(dir, root, out) {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (name === '.gitkeep' || name === '.DS_Store' || name === 'Thumbs.db') continue;
		const full = join(dir, name);
		const stats = statSync(full);
		if (stats.isDirectory()) collectSqlFiles(full, root, out);
		else if (stats.isFile() && name.toLowerCase().endsWith('.sql')) out.push(normalizePath(relative(root, full)));
	}
}

function validateSql(bytes, file) {
	if (bytes.byteLength < 1) throw new Error('Database migration is empty: ' + file);
	if (bytes.byteLength > MAX_MIGRATION_BYTES) throw new Error('Database migration exceeds 2 MiB: ' + file);
	const sql = bytes.toString('utf8');
	if (/\b(?:begin|commit|rollback)\s*;/i.test(sql)) {
		throw new Error('Database migrations must not contain explicit transaction control; the customer updater wraps each migration atomically: ' + file);
	}
	if (/\b(?:drop\s+table|drop\s+schema|truncate\s+(?:table\s+)?|alter\s+table[\s\S]{0,300}?drop\s+column)\b/i.test(sql)) {
		throw new Error('Destructive customer database migrations are not permitted in Update releases. Add a forward-compatible migration instead: ' + file);
	}
}

function buildMigration(root, file) {
	const parsed = parseMigrationPath(file);
	if (!parsed) throw new Error('Invalid migration path: ' + file);
	const full = resolve(root, parsed.path);
	if (!existsSync(full) || !statSync(full).isFile()) throw new Error('Database migration file is missing: ' + parsed.path);
	const bytes = readFileSync(full);
	validateSql(bytes, parsed.path);
	return {
		id: parsed.id,
		file: parsed.path,
		component: parsed.component,
		encoding: 'base64',
		data: bytes.toString('base64'),
		size: bytes.byteLength,
		sha256: createHash('sha256').update(bytes).digest('hex')
	};
}

export function buildDatabaseContract({ root = process.cwd(), releaseAnalysis = {}, components = [] } = {}) {
	const selected = new Set((Array.isArray(components) ? components : [])
		.map((value) => String(value || '').trim().toLowerCase())
		.filter((value) => UPDATE_COMPONENTS.has(value)));
	const analyzedFiles = Array.isArray(releaseAnalysis?.files) ? releaseAnalysis.files : [];
	const changedMigrations = [];

	for (const item of analyzedFiles) {
		const file = normalizePath(item?.file || item?.filename || '');
		const status = String(item?.status || '').trim().toUpperCase();
		if (!file.toLowerCase().endsWith('.sql')) continue;
		if (isLegacyFlatMigration(file)) {
			if (!status.startsWith('A')) throw new Error('Legacy pre-snapshot migration is frozen and must not be modified, renamed, or deleted: ' + file);
			continue;
		}
		const parsed = parseMigrationPath(file);
		if (!parsed) throw new Error('Database SQL changes must be under supabase/migrations/{shared|apex|mcp|studio}/YYYYMMDDHHMMSS_description.sql: ' + file);
		if (parsed.component === 'base') throw new Error('Normal Engine updates must not contain Base database migrations. Add Base migrations to V1-vercel-base instead: ' + file);
		if (!status.startsWith('A')) throw new Error('Published customer database migrations are immutable. Add a new migration instead of modifying, renaming, or deleting: ' + file);
		if (parsed.component === 'shared') {
			if (!selected.size) throw new Error('Shared database migration requires at least one Engine component target: ' + file);
		} else if (!selected.has(parsed.component)) {
			throw new Error('Database migration belongs to an unselected component: ' + file);
		}
		changedMigrations.push(parsed.path);
	}

	if (releaseAnalysis?.flags?.schemaChanged === true && changedMigrations.length === 0) {
		throw new Error('Database/schema changes were detected, but no new immutable customer migration was added.');
	}

	const migrationRoot = resolve(root, 'supabase/migrations');
	const allFiles = [];
	collectSqlFiles(migrationRoot, root, allFiles);
	const migrations = [];
	const seenIds = new Set();
	let totalBytes = 0;

	allFiles.sort((a, b) => {
		const aName = a.split('/').at(-1) || a;
		const bName = b.split('/').at(-1) || b;
		return aName.localeCompare(bName) || a.localeCompare(b);
	});

	for (const file of allFiles) {
		if (isLegacyFlatMigration(file)) continue;
		const parsed = parseMigrationPath(file);
		if (!parsed) throw new Error('Invalid customer migration filename/path: ' + file);
		if (parsed.component === 'base') throw new Error('Base database migrations are not permitted in V1-vercel-engine Update releases: ' + file);
		if (parsed.component !== 'shared' && !selected.has(parsed.component)) continue;
		if (parsed.component === 'shared' && !selected.size) continue;
		const migration = buildMigration(root, file);
		if (seenIds.has(migration.id)) throw new Error('Duplicate database migration id: ' + migration.id);
		seenIds.add(migration.id);
		totalBytes += migration.size;
		if (totalBytes > MAX_DATABASE_BYTES) throw new Error('Customer database migration history exceeds the 8 MiB Update Bundle limit.');
		migrations.push(migration);
	}

	for (const file of changedMigrations) {
		if (!migrations.some((migration) => migration.file === file)) {
			throw new Error('Changed customer migration is not included in selected component history: ' + file);
		}
	}

	return {
		database: {
			format: 'orbitfs-db-migrations-v1',
			mode: 'shared-panel',
			provider: 'supabase',
			migrationCount: migrations.length,
			migrations
		},
		changedMigrationCount: changedMigrations.length,
		totalBytes
	};
}

export function validateDatabaseTree(root = process.cwd()) {
	return buildDatabaseContract({
		root,
		releaseAnalysis: { files: [], flags: { schemaChanged: false } },
		components: ['apex', 'mcp', 'studio']
	});
}
