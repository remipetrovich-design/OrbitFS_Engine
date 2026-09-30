import { error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { getEngineHubEngine } from '$lib/server/engine-hub';

export async function load({ cookies, params }) {
	await requireAdmin(cookies);
	const engine = await getEngineHubEngine(params.engine);
	if (!engine.registered) throw error(404, 'Engine is not registered. Install it from OrbitFS Panel first.');
	if (!engine.licensed) throw error(403, 'This OrbitFS installation is not licensed for this engine.');
	return {
		engineLicenseGate: true,
		engineId: engine.id,
		engineLicensed: true,
		engineConsoleAccess: true
	};
}
