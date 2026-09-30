import { requireAdmin } from '$lib/server/auth';
import { getEngineReadiness } from '$lib/server/engine-readiness';

export async function load({ cookies, params }) {
	const user = await requireAdmin(cookies);
	const readiness = await getEngineReadiness(params.engine);
	return { user, ...readiness };
}
