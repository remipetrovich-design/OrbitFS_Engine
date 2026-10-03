import { compareOrbitReleaseVersions, isOrbitReleaseVersion } from './release-version.mjs';

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value) {
  return String(value ?? '').trim();
}

function databaseSnapshotSha(release) {
  const manifest = objectValue(release?.manifest);
  const releaseInfo = objectValue(manifest.releaseInfo);
  const database = objectValue(manifest.database);
  return clean(
    manifest.databaseSchemaSha256 ||
    releaseInfo.databaseSchemaSha256 ||
    database.schemaSha256 ||
    database.sha256
  ).toLowerCase();
}

function databaseSchemaVersion(release) {
  const manifest = objectValue(release?.manifest);
  const releaseInfo = objectValue(manifest.releaseInfo);
  const database = objectValue(manifest.database);
  const raw = manifest.databaseSchemaVersion || releaseInfo.databaseSchemaVersion || database.schemaVersion || null;
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function publishedAt(release) {
  const value = Date.parse(clean(release?.published_at || release?.created_at));
  return Number.isFinite(value) ? value : 0;
}

export function selectCompatibleBaseRelease(payload, input = {}) {
  const minimumBaseVersion = clean(input.minimumBaseVersion);
  const channel = clean(input.channel).toLowerCase();

  if (!isOrbitReleaseVersion(minimumBaseVersion)) {
    throw Object.assign(new Error('Invalid minimum Base version: ' + minimumBaseVersion), { code: 'MINIMUM_BASE_VERSION_INVALID' });
  }
  if (!channel) {
    throw Object.assign(new Error('Base release channel is required.'), { code: 'BASE_CHANNEL_REQUIRED' });
  }

  const releases = Array.isArray(payload?.releases) ? payload.releases : [];
  const channelRows = releases.filter((release) => {
    return clean(release?.status).toLowerCase() === 'published' &&
      clean(release?.review_status).toLowerCase() === 'approved' &&
      !release?.archived_at &&
      clean(release?.channel || 'stable').toLowerCase() === channel;
  });

  const withSnapshot = channelRows.filter((release) => /^[a-f0-9]{64}$/i.test(databaseSnapshotSha(release)));
  const compatible = withSnapshot.filter((release) => {
    const version = clean(release?.version);
    const comparison = compareOrbitReleaseVersions(version, minimumBaseVersion);
    return comparison !== null && comparison >= 0;
  });

  compatible.sort((a, b) => {
    const versionComparison = compareOrbitReleaseVersions(clean(b?.version), clean(a?.version));
    if (versionComparison !== null && versionComparison !== 0) return versionComparison;
    return publishedAt(b) - publishedAt(a);
  });

  const selected = compatible[0];
  if (!selected) {
    const available = withSnapshot
      .map((release) => clean(release?.version))
      .filter(Boolean)
      .sort((a, b) => compareOrbitReleaseVersions(b, a) ?? 0);

    const detail = available.length
      ? ' Approved published Base versions with a database snapshot in ' + channel + ': ' + available.join(', ') + '.'
      : ' No approved published Base release with the database snapshot contract exists in ' + channel + '.';

    throw Object.assign(
      new Error('No compatible published Base release satisfies minimum Base ' + minimumBaseVersion + ' in channel ' + channel + '.' + detail),
      {
        code: 'COMPATIBLE_BASE_RELEASE_NOT_FOUND',
        minimumBaseVersion,
        channel,
        available
      }
    );
  }

  return {
    id: clean(selected.id),
    version: clean(selected.version),
    source: clean(selected.source_sha),
    channel: clean(selected.channel || channel).toLowerCase(),
    minimumBaseVersion,
    compatibility: 'at_or_above_minimum',
    databaseSchemaSha256: databaseSnapshotSha(selected),
    databaseSchemaVersion: databaseSchemaVersion(selected)
  };
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function selfTest() {
  const sha = 'a'.repeat(64);
  const payload = {
    releases: [
      { id: 'old', version: '1.0.0', channel: 'beta', status: 'published', review_status: 'approved', manifest: { databaseSchemaSha256: sha } },
      { id: 'current', version: '1.0.2', channel: 'stable', status: 'published', review_status: 'approved', published_at: '2026-09-29T00:00:00Z', manifest: { databaseSchemaSha256: sha } },
      { id: 'draft', version: '1.0.9', channel: 'stable', status: 'draft', review_status: 'approved', manifest: { databaseSchemaSha256: sha } }
    ]
  };
  const selected = selectCompatibleBaseRelease(payload, { minimumBaseVersion: '1.0.0', channel: 'stable' });
  if (selected.version !== '1.0.2') throw new Error('Expected Base 1.0.2 to satisfy minimum Base 1.0.0');
  let blocked = false;
  try {
    selectCompatibleBaseRelease(payload, { minimumBaseVersion: '1.0.3', channel: 'stable' });
  } catch (error) {
    blocked = error?.code === 'COMPATIBLE_BASE_RELEASE_NOT_FOUND';
  }
  if (!blocked) throw new Error('Expected minimum Base 1.0.3 to reject Base 1.0.2');
  process.stdout.write(JSON.stringify({ ok: true, selected: selected.version }) + '\n');
}

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const index = args.indexOf('--' + name);
  return index >= 0 ? String(args[index + 1] ?? fallback) : fallback;
};

if (args.includes('--self-test')) {
  await selfTest();
} else {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw || '{}');
    const result = selectCompatibleBaseRelease(payload, {
      minimumBaseVersion: arg('minimum', process.env.MINIMUM_BASE_VERSION || ''),
      channel: arg('channel', process.env.BASE_CHANNEL || 'stable')
    });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message + '\n');
    process.exitCode = 3;
  }
}