import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildDatabaseContract } from './database-migrations.mjs';
import { isOrbitReleaseVersion } from './release-version.mjs';

const ROOT = resolve(process.cwd());
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? String(args[i + 1] || fallback) : fallback;
};
const version = arg('version', process.env.ORBITFS_ENGINE_RELEASE_VERSION || '0.0.0-dev').trim();
const components = [...new Set(arg('components', '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
const changedFilesRaw = arg('changed-files', '[]');
let changedFiles = [];
try { changedFiles = JSON.parse(changedFilesRaw); if (!Array.isArray(changedFiles)) throw new Error(); } catch { throw new Error('Invalid changed-files JSON'); }
changedFiles = changedFiles.map((item) => typeof item === 'string' ? { filename: item, status: 'M' } : { filename: String(item?.filename || item?.file || ''), status: String(item?.status || 'M'), additions: Number(item?.additions || 0), deletions: Number(item?.deletions || 0) }).filter((item) => item.filename);
const output = resolve(ROOT, arg('output', 'engine-release.json.gz'));
const releaseNotesFile = arg('release-notes', 'release-notes.md');
const releaseAnalysisFile = arg('release-analysis', 'release-analysis.json');
const sourceCommit = arg('commit', process.env.GITHUB_SHA || '').trim() || null;
const minimumUpdaterProtocol = Number(arg('minimum-updater-protocol', arg('minimum-deployer-protocol', process.env.ORBITFS_MINIMUM_UPDATER_PROTOCOL || '2')));
const minimumBaseVersion = arg('minimum-base-version', process.env.ORBITFS_MINIMUM_BASE_VERSION || '1.0.0').trim();
const allowedComponents = new Set(['base', 'apex', 'mcp', 'studio']);
const engineComponents = new Set(['apex', 'mcp', 'studio']);
const componentManifestPaths = {
	apex: 'src/addons/apex/manifest.ts',
	mcp: 'src/addons/mcp/manifest.ts',
	studio: 'src/addons/studio/manifest.ts'
};

if (!isOrbitReleaseVersion(version)) throw new Error('Invalid OrbitFS Engine release version');
if (!components.length) throw new Error('Select at least one update target');
if (!Number.isInteger(minimumUpdaterProtocol) || minimumUpdaterProtocol < 1 || minimumUpdaterProtocol > 100) throw new Error('minimum Updater protocol must be an integer from 1 to 100');
if (!isOrbitReleaseVersion(minimumBaseVersion)) throw new Error('Invalid minimum Base version');
for (const component of components) {
	if (!allowedComponents.has(component)) throw new Error(`Unknown Engine release component: ${component}`);
}

const topFiles = ['.npmrc', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'];
const topDirectories = ['src', 'static'];
const excludedNames = new Set(['.DS_Store', 'Thumbs.db']);

function collectDirectory(path, files) {
	for (const name of readdirSync(path)) {
		if (excludedNames.has(name)) continue;
		const full = join(path, name);
		const stats = statSync(full);
		if (stats.isDirectory()) collectDirectory(full, files);
		else if (stats.isFile()) files.push(full);
	}
}

const selected = [];
for (const name of topFiles) {
	const full = join(ROOT, name);
	if (existsSync(full) && statSync(full).isFile()) selected.push(full);
}
for (const name of topDirectories) {
	const full = join(ROOT, name);
	if (existsSync(full) && statSync(full).isDirectory()) collectDirectory(full, selected);
}
selected.sort((a, b) => a.localeCompare(b));
if (!selected.some((file) => relative(ROOT, file).replaceAll('\\', '/') === 'package.json')) throw new Error('package.json is required');
if (!selected.some((file) => relative(ROOT, file).replaceAll('\\', '/').startsWith('src/'))) throw new Error('src files are required');

function componentForPath(path) {
	const normalized = path.replaceAll('\\\\', '/');
	if (normalized.startsWith('src/addons/apex/')) return 'apex';
	if (normalized.startsWith('src/addons/mcp/')) return 'mcp';
	if (normalized.startsWith('src/addons/studio/')) return 'studio';
	return 'shared';
}
function extractManifestVersion(component) {
	const manifestPath = componentManifestPaths[component];
	if (!manifestPath || !existsSync(resolve(ROOT, manifestPath))) return null;
	const source = readFileSync(resolve(ROOT, manifestPath), 'utf8');
	const match = source.match(/\\bversion\\s*:\s*['"]([^'"]+)['"]/);
	return match ? match[1] : null;
}
const packageVersion = (() => { try { const pkg=JSON.parse(readFileSync(resolve(ROOT,'package.json'),'utf8')); return String(pkg.version||version); } catch { return version; } })();
const componentVersions = {};
for (const component of components.filter((value) => engineComponents.has(value))) componentVersions[component] = extractManifestVersion(component) || packageVersion;
const files = selected.map((full) => {
	const path = relative(ROOT, full).replaceAll('\\', '/');
	if (!path || path.startsWith('../') || path.includes('/../')) throw new Error(`Unsafe release path: ${path}`);
	const bytes = readFileSync(full);
	return { file: path, component: componentForPath(path), data: bytes.toString('base64'), encoding: 'base64', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const componentFileCounts=files.reduce((out,file)=>{out[file.component]=(out[file.component]||0)+1;return out;},{shared:0,apex:0,mcp:0,studio:0});
const executionPolicy={
	mode:'per-installation-entitlement-intersection-v1',
	artifact:'complete-engine-snapshot',
	fileClassification:'component',
	sharedFiles:'always-required',
	componentFiles:'apply-only-when-authorized'
};

const releaseNotes = existsSync(resolve(ROOT, releaseNotesFile)) ? readFileSync(resolve(ROOT, releaseNotesFile), 'utf8') : '';
let releaseAnalysis = {};
if (existsSync(resolve(ROOT, releaseAnalysisFile))) { try { releaseAnalysis = JSON.parse(readFileSync(resolve(ROOT, releaseAnalysisFile), 'utf8')); } catch { throw new Error('Invalid release analysis JSON'); } }

const detectedComponents = Array.isArray(releaseAnalysis?.detectedComponents) ? releaseAnalysis.detectedComponents.map((x) => String(x).toLowerCase()) : [];
const changedComponents = detectedComponents.filter((x) => allowedComponents.has(x) || x === 'shared');
const selectedSet = new Set(components);
if (changedComponents.includes('shared')) {
	for (const component of engineComponents) {
		if (!selectedSet.has(component)) throw new Error('Shared Engine runtime changes affect APEX, MCP and Studio; select all Engine components for this release.');
	}
}
for (const component of changedComponents.filter((x) => x !== 'shared')) {
	if (!selectedSet.has(component)) throw new Error('Release contains ' + component + ' changes but ' + component + ' was not selected.');
}
const databaseResult = buildDatabaseContract({ root: ROOT, releaseAnalysis, components });
const database = databaseResult.database;
const payload = {
	schemaVersion: 3,
	format: 'orbitfs-engine-release-v3',
	manifestVersion: 1,
	version,
	components,
	componentVersions,
	changedComponents,
	changedFiles,
	componentFileCounts,
	executionPolicy,
	updateScope: 'deployed-system-v2',
	executor: 'orbitfs-updater-v2',
	changedFileCount: changedFiles.length,
	checkpointRequired: true,
	minimumUpdaterProtocol,
	minimumBaseVersion,
	releaseId: `engine-${version}`,
	sourceCommit,
	createdAt: new Date().toISOString(),
	releaseNotes,
	releaseAnalysis,
	database,
	databaseMigrationCount: database.migrationCount,
	databaseChangedMigrationCount: databaseResult.changedMigrationCount,
	fileCount: files.length,
	projectSettings: {
		framework: 'sveltekit',
		buildCommand: 'npm run build',
		installCommand: 'npm ci'
	},
	files
};
const json = Buffer.from(JSON.stringify(payload));
const archive = gzipSync(json, { level: 9 });
writeFileSync(output, archive);
const sha256 = createHash('sha256').update(archive).digest('hex');
const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
console.log(JSON.stringify({
	ok: true,
	version,
	components,
	checkpointRequired: true,
	minimumUpdaterProtocol,
	minimumBaseVersion,
	output: basename(output),
	sha256,
	fileCount: files.length,
	databaseMigrationCount: database.migrationCount,
	databaseChangedMigrationCount: databaseResult.changedMigrationCount,
	sourceBytes: totalBytes,
	archiveBytes: archive.byteLength
}, null, 2));
