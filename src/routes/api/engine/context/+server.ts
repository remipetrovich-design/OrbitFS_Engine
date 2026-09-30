import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth';
import { engineCatalogAccess } from '$lib/server/engine-access';
import { listEngineHubEngines } from '$lib/server/engine-hub';
import { getPanelLicenseSummary } from '$lib/server/license';
import { visibleWorkspaces } from '$lib/server/workspaces';

export async function GET({ cookies }) {
	try {
		const user = await requireUser(cookies);
		const [workspaceRows, license, allEngines] = await Promise.all([
			visibleWorkspaces(user),
			getPanelLicenseSummary(),
			listEngineHubEngines()
		]);
		const engines = await engineCatalogAccess(user, allEngines);
		const mainWorkspace = workspaceRows.find((workspace: any) => workspace.is_main) || workspaceRows[0] || null;
		const linkedPanel = engines.find((engine: any) => engine.panelUrl)?.panelUrl || 'https://orbitfs.vercel.app';

		return json(
			{
				user: {
					id: user.id,
					username: user.username,
					displayName: user.display_name,
					email: user.email,
					role: user.role,
					avatarUrl: user.avatar_url,
					permissions: user.permissions || {}
				},
				installation: {
					id: license.installationId,
					licensed: license.licensed,
					plan: license.plan,
					licensedTo: license.licensedTo,
					expiresAt: license.expiresAt,
					panelUrl: linkedPanel,
					engineHostUrl: 'https://orbitfsengine.vercel.app'
				},
				mainWorkspace,
				workspaces: workspaceRows,
				engines: engines.map((engine: any) => ({
					id: engine.id,
					name: engine.name,
					component: engine.component,
					installed: engine.installed,
					attached: engine.attached,
					licensed: engine.licensed,
					licenseState: engine.licenseState,
					licenseReason: engine.licenseReason,
					linked: engine.linked,
					setupState: engine.setupState,
					engineState: engine.engineState,
					workspaceId: engine.workspaceId,
					workspaceName: engine.workspaceName,
					accessWorkspaceCount: engine.accessWorkspaceCount,
					accessWorkspaceNames: engine.accessWorkspaceNames,
					transportPath: engine.transportPath
				}))
			},
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error: any) {
		return json(
			{ error: String(error?.message || 'Engine Host context failed'), code: String(error?.code || 'ENGINE_CONTEXT_FAILED') },
			{ status: Number(error?.status || 500), headers: { 'cache-control': 'no-store' } }
		);
	}
}
