import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? String(args[index + 1] || fallback) : fallback;
};

const kind = arg('kind', 'engine').trim().toLowerCase();
const fromCommit = arg('from', '').trim();
const toCommit = arg('to', process.env.GITHUB_SHA || 'HEAD').trim();
const drafterPath = arg('release-drafter', '').trim();
const output = resolve(process.cwd(), arg('output', 'release-analysis.json'));
if (!['panel', 'engine'].includes(kind)) throw new Error('Release analysis kind must be panel or engine');

function git(parameters, fallback = '') {
	try {
		return execFileSync('git', parameters, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
	} catch {
		return fallback;
	}
}

const hasFrom = Boolean(fromCommit && git(['cat-file', '-e', `${fromCommit}^{commit}`], 'missing') === '');
const range = hasFrom ? `${fromCommit}..${toCommit}` : '';
const nameStatusText = hasFrom ? git(['diff', '--name-status', fromCommit, toCommit]) : git(['show', '--format=', '--name-status', toCommit]);
const numstatText = hasFrom ? git(['diff', '--numstat', fromCommit, toCommit]) : git(['show', '--format=', '--numstat', toCommit]);
const logText = hasFrom ? git(['log', '--format=%H%x09%s', range]) : git(['show', '-s', '--format=%H%x09%s', toCommit]);

const files = nameStatusText.split('\n').filter(Boolean).slice(0, 600).map((line) => {
	const parts = line.split('\t');
	const status = parts.shift() || 'M';
	const file = parts.at(-1) || '';
	return { status, file };
}).filter((item) => item.file);

let additions = 0;
let deletions = 0;
for (const line of numstatText.split('\n').filter(Boolean)) {
	const [add, del] = line.split('\t');
	if (/^\d+$/.test(add || '')) additions += Number(add);
	if (/^\d+$/.test(del || '')) deletions += Number(del);
}

const commits = logText.split('\n').filter(Boolean).slice(0, 120).map((line) => {
	const [sha, ...subject] = line.split('\t');
	return { sha, subject: subject.join('\t').slice(0, 240) };
});

const detected = new Set();
if (kind === 'panel') detected.add('core');
function hasBaseDeletionEntries() {
	const file = resolve(process.cwd(), 'updates/base/delete.txt');
	if (!existsSync(file)) return false;
	return readFileSync(file, 'utf8').split(/\r?\n/).some((line) => {
		const value = line.trim();
		return Boolean(value && !value.startsWith('#'));
	});
}
const flags = { schemaChanged: false, dependenciesChanged: false, engineDeployerChanged: false, deploymentChanged: false, apiChanged: false, uiChanged: false };
for (const item of files) {
	const path = item.file.toLowerCase().replaceAll('\\', '/');
	const migration = path.match(/^supabase\/migrations\/(shared|base|apex|mcp|studio)\/\d{14}_[a-z0-9._-]+\.sql$/i);
	const legacyMigration = path === 'supabase/migrations/20260908_engine_hot_path_optimizations.sql'
		|| path === 'supabase/migrations/20260908_normalize_context_library_storage.sql';
	const sourcePath = path.startsWith('src/') || /^(package(-lock)?\.json|tsconfig\.json|vite\.config\.ts|\.npmrc)$/.test(path);

	if (path.startsWith('updates/base/overlay/') && !path.endsWith('/.gitkeep') && !path.endsWith('.gitkeep')) detected.add('base');
	if (path === 'updates/base/delete.txt' && hasBaseDeletionEntries()) detected.add('base');
	if (migration && migration[1] !== 'shared') detected.add(migration[1]);
	if (!migration && sourcePath && !path.includes('/addons/apex/') && !path.includes('/addons/mcp/') && !path.includes('/addons/studio/')) detected.add('shared');
	if (path.includes('/addons/apex/')) detected.add('apex');
	if (path.includes('/addons/mcp/')) detected.add('mcp');
	if (path.includes('/addons/studio/')) detected.add('studio');

	if ((path.endsWith('.sql') && !legacyMigration) || /(^|\/)schema(?:\.|\/)/i.test(path)) flags.schemaChanged = true;
	if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path)) flags.dependenciesChanged = true;
	if (path.includes('engine-release') || path.includes('engine-host') || path.includes('vercel')) flags.engineDeployerChanged = true;
	if (path.includes('.github/workflows/') || path.includes('deploy') || path.includes('vercel')) flags.deploymentChanged = true;
	if (path.includes('/api/') || path.includes('/routes/api/') || path.includes('/routes/api')) flags.apiChanged = true;
	if (path.endsWith('.svelte') || path.endsWith('.tsx') || path.endsWith('.css') || path.includes('/routes/')) flags.uiChanged = true;
}

let releaseDrafter = null;
if (drafterPath && existsSync(drafterPath)) {
	try {
		const raw = JSON.parse(readFileSync(drafterPath, 'utf8'));
		releaseDrafter = {
			name: raw?.name || null,
			tagName: raw?.tag_name || null,
			resolvedVersion: raw?.resolved_version || null,
			targetCommitish: raw?.target_commitish || null,
			body: String(raw?.body || '').slice(0, 32_000)
		};
	} catch {}
}

const report = {
	format: 'orbitfs-release-analysis-v1',
	kind,
	generatedAt: new Date().toISOString(),
	fromCommit: hasFrom ? fromCommit : null,
	toCommit,
	baseline: !hasFrom,
	commitCount: commits.length,
	commits,
	fileCount: files.length,
	files,
	additions,
	deletions,
	detectedComponents: [...detected].sort(),
	flags,
	releaseDrafter
};

writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, output, commitCount: report.commitCount, fileCount: report.fileCount, additions, deletions, detectedComponents: report.detectedComponents, flags }, null, 2));
