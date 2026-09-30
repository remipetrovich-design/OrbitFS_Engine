import { env } from '$env/dynamic/private';
import { requireAdmin } from '$lib/server/auth';
import { accessibleWorkspaces } from '$lib/server/base-compat';
import { listEngineHubEngines } from '$lib/server/engine-hub';
import { ensureInstallationIdentity, getLicenseProviderSettings, getPanelLicenseSummary } from '$lib/server/license';
import { getSharedEngineHostState } from '$lib/server/shared-engine-host';

function cleanHttps(value: string, fallback: string) {
	try {
		const parsed = new URL(String(value || fallback).trim());
		if (parsed.protocol !== 'https:') throw new Error();
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return fallback;
	}
}

function runtimeEngineOrigin(urlOrigin:string) {
	const raw=String(env.ORBITFS_ENGINE_HOST_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || urlOrigin || '').trim();
	const normalized=raw && !raw.startsWith('http') ? `https://${raw}` : raw;
	return cleanHttps(normalized, cleanHttps(urlOrigin, ''));
}

export async function load({ cookies, url }) {
	const user = await requireAdmin(cookies);
	const [engines, workspaces, installationId, licenseProvider, license, host] = await Promise.all([
		listEngineHubEngines(),
		accessibleWorkspaces(user),
		ensureInstallationIdentity(),
		getLicenseProviderSettings(),
		getPanelLicenseSummary(),
		getSharedEngineHostState()
	]);

	const panelUrl = cleanHttps(String(host.panelUrl || env.ORBITFS_PANEL_URL || ''), 'https://orbitfs.vercel.app');
	const engineHostUrl = cleanHttps(String(host.hostUrl || runtimeEngineOrigin(url.origin)), runtimeEngineOrigin(url.origin));
	const mainWorkspace = workspaces.find((workspace: any) => workspace.is_main) || workspaces[0] || null;
	const databaseSecret = Boolean(String(env.ORBITFS_DB_SECRET || '').trim());
	const supabaseConfigured = Boolean(
		String(env.SUPABASE_URL || '').trim() &&
		String(env.SUPABASE_PUBLISHABLE_KEY || '').trim() &&
		databaseSecret
	);
	const currentOrigin = cleanHttps(url.origin, engineHostUrl);
	const vercelEnvironment = String(env.VERCEL_ENV || 'local').toLowerCase();
	const branch = String(env.VERCEL_GIT_COMMIT_REF || '').trim() || null;

	return {
		user,
		engines,
		installationId,
		mainWorkspace,
		workspaceCount: workspaces.length,
		host,
		services: {
			panelUrl,
			engineHostUrl,
			mcpUrl: `${engineHostUrl}/mcp`,
			licenseProvider: licenseProvider.providerBase
		},
		deployment: {
			environment: vercelEnvironment,
			branch,
			currentOrigin,
			canonicalOrigin: engineHostUrl,
			canonical: currentOrigin === engineHostUrl
		},
		backend: {
			compute: 'Vercel / SvelteKit',
			database: 'Supabase Postgres',
			storage: 'Supabase Storage',
			filesystem: 'Virtual OrbitFS Library paths backed by Supabase',
			supabaseConfigured,
			pairingRegistryConfigured: ['linked','ready'].includes(String(host.state)) && Boolean(host.panelUrl) && Boolean(host.hostUrl)
		},
		license: {
			licensed: license.licensed,
			status: license.status,
			plan: license.plan,
			licensedTo: license.licensedTo,
			expiresAt: license.expiresAt,
			lastCheckedAt: license.lastCheckedAt
		}
	};
}
