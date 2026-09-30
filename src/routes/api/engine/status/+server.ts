import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { authorizeEngineHostRequest } from '$lib/server/engine-host-link';
import { ensureInstallationIdentity } from '$lib/server/license';
import { listEngineHubEngines } from '$lib/server/engine-hub';

export async function GET({ request }) {
	if (!authorizeEngineHostRequest(request)) {
		return json({ ok: false, error: 'Unauthorized', code: 'ENGINE_HOST_UNAUTHORIZED' }, { status: 401 });
	}

	try {
		const [installationId, engines] = await Promise.all([
			ensureInstallationIdentity(),
			listEngineHubEngines()
		]);
		const databaseSecret = Boolean(String(env.ORBITFS_DB_SECRET || '').trim());
		const serviceKey = Boolean(String(env.SUPABASE_SECRET_KEY || '').trim());
		const publishableKey = Boolean(String(env.SUPABASE_PUBLISHABLE_KEY || '').trim());
		const dedicatedEngineSecret = Boolean(String(env.ORBITFS_ENGINE_SECRET || '').trim());
		const backendReady = Boolean(String(env.SUPABASE_URL || '').trim() && (serviceKey || (publishableKey && databaseSecret)));
		return json({
			ok: true,
			service: 'orbitfs-engine-host',
			version: 2,
			installationId,
			canonical: {
				panel: 'https://orbitfs.vercel.app',
				engineHost: 'https://orbitfsengine.vercel.app',
				mcp: 'https://orbitfsengine.vercel.app/mcp'
			},
			deployment: {
				environment: String(env.VERCEL_ENV || 'local'),
				branch: String(env.VERCEL_GIT_COMMIT_REF || '') || null,
				compute: 'vercel',
				storage: 'supabase',
				filesystem: false
			},
			readiness: {
				backendReady,
				pairingConfigured: dedicatedEngineSecret || databaseSecret,
				pairingSecretSource: dedicatedEngineSecret ? 'dedicated' : databaseSecret ? 'database_fallback' : 'missing',
				databaseCredentialMode: serviceKey ? 'service_key' : databaseSecret ? 'server_secret' : 'missing',
				signedPairingRequired: true
			},
			engines: engines.map((engine) => ({
				id: engine.id,
				component: engine.component,
				registered: engine.registered,
				installed: engine.installed,
				attached: engine.attached,
				licensed: engine.licensed,
				licenseState: engine.licenseState,
				licenseReason: engine.licenseReason,
				linked: engine.linked,
				setupState: engine.setupState,
				engineState: engine.engineState,
				workspaceId: engine.workspaceId,
				lastSyncAt: engine.lastSyncAt,
				transportPath: engine.transportPath
			}))
		}, { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return json({ ok: false, error: error?.message || 'Engine Host status failed', code: error?.code || 'ENGINE_HOST_STATUS_FAILED' }, { status: Number(error?.status || 500), headers: { 'cache-control': 'no-store' } });
	}
}
