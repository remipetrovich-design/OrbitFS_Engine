import { redirect } from '@sveltejs/kit';
import { destroySession, requireAdmin } from '$lib/server/auth';
import { accessibleWorkspaces } from '$lib/server/base-compat';
import { engineCatalogAccess } from '$lib/server/engine-access';
import { ensureInstallationIdentity } from '$lib/server/license';
import { listEngineHubEngines } from '$lib/server/engine-hub';
import { getSharedEngineHostState } from '$lib/server/shared-engine-host';

export async function load({ cookies }) {
	const user = await requireAdmin(cookies);
	const [allEngines, workspaces, installationId, host] = await Promise.all([
		listEngineHubEngines(),
		accessibleWorkspaces(user),
		ensureInstallationIdentity(),
		getSharedEngineHostState()
	]);
	const engines = await engineCatalogAccess(user, allEngines);
	const mainWorkspace = workspaces.find((workspace: any) => workspace.is_main) || workspaces[0] || null;
	return { user, engines, mainWorkspace, workspaceCount: workspaces.length, installationId, host, canManage: true };
}

export const actions = {
	logout: async ({ cookies }) => {
		await destroySession(cookies);
		throw redirect(303, '/login');
	}
};
