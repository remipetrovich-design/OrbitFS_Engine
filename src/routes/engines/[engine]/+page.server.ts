import { error, fail } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth';
import { engineAccess } from '$lib/server/engine-access';
import { getEngineHubEngine, setEngineSetupState } from '$lib/server/engine-hub';
import { getEngineReadiness } from '$lib/server/engine-readiness';
import { setAddonEngineMode } from '$lib/server/addon-engine';

function canManage(user: any) {
	return ['owner','admin'].includes(String(user.role || '').toLowerCase());
}

export async function load({ cookies, params }) {
	const user = await requireUser(cookies);
	const engine = await getEngineHubEngine(params.engine);
	if (!engine.registered) throw error(404, 'Engine is not registered');
	const access = await engineAccess(user, engine.id);
	if (!access.allowed) throw error(403, 'You do not have workspace permission to use this OrbitFS engine.');
	return {
		user,
		engine,
		canManage: canManage(user),
		accessWorkspaces: access.workspaces.map((workspace: any) => ({ id: workspace.id, name: workspace.name, permission: workspace.permission }))
	};
}

export const actions = {
	setup: async ({ cookies, params, request }) => {
		const user = await requireUser(cookies);
		if (!canManage(user)) return fail(403, { error: 'Engine setup requires an OrbitFS administrator.' });
		const form = await request.formData();
		const state = String(form.get('state') || '');
		if (!['required','in_progress','complete','error'].includes(state)) return fail(400, { error: 'Invalid setup state.' });
		if (state === 'complete') {
			const readiness = await getEngineReadiness(params.engine);
			if (!readiness.ready) return fail(409, { error: `Setup cannot complete yet. Blocking checks: ${readiness.blocking.join(', ')}.` });
		}
		await setEngineSetupState(params.engine, state as any, String(user.id));
		return { ok: true };
	},
	runtime: async ({ cookies, params, request }) => {
		const user = await requireUser(cookies);
		if (!canManage(user)) return fail(403, { error: 'Engine runtime control requires an OrbitFS administrator.' });
		const form = await request.formData();
		const action = String(form.get('action') || '').toLowerCase();
		if (!['running','standby','stopped','restart'].includes(action)) return fail(400, { error: 'Invalid runtime action.' });
		const engine = await getEngineHubEngine(params.engine);
		if (!engine.attached || !engine.linked) return fail(409, { error: 'Attach and link this engine from Panel before changing runtime state.' });
		if (!engine.licensed) return fail(403, { error: 'This engine is not licensed for the current OrbitFS installation.' });
		await setAddonEngineMode(params.engine, action as any, String(user.id));
		return { ok: true };
	}
};
