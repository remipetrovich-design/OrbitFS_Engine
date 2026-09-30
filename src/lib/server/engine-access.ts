import type { OrbitUser } from '$lib/server/auth';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { isSystemAdmin, visibleWorkspaces } from '$lib/server/workspaces';

export type EngineAccess = {
	allowed: boolean;
	admin: boolean;
	workspaces: any[];
};

function workspaceAllowsEngine(workspace: any, engineId: string) {
	const permissions = workspace?.management_permissions || {};
	if (engineId === 'apex') {
		return workspace?.apex_system_enabled !== false && (permissions.sorter_view === true || permissions.converter_view === true);
	}
	if (engineId === 'studio') {
		return permissions.studio_view === true;
	}
	return false;
}

async function mcpWorkspaceAccess(user: OrbitUser) {
	const db = getSupabaseAdmin();
	const [workspaceResult, membershipResult] = await Promise.all([
		db.from('orbitfs_workspaces')
			.select('id,name,status,visibility,is_main,owner_id,created_by,mcp_ui_enabled,mcp_system_enabled')
			.neq('status', 'archived')
			.order('is_main', { ascending: false })
			.order('name'),
		db.from('orbitfs_workspace_members').select('workspace_id,role,mcp_enabled').eq('user_id', user.id)
	]);
	if (workspaceResult.error) throw workspaceResult.error;
	if (membershipResult.error) throw membershipResult.error;

	const memberships = new Map((membershipResult.data || []).map((row: any) => [String(row.workspace_id), row]));
	return (workspaceResult.data || []).flatMap((workspace: any) => {
		if (workspace.mcp_system_enabled === false) return [];
		const membership: any = memberships.get(String(workspace.id));
		if (membership?.mcp_enabled === false) return [];
		const ownsWorkspace = String(workspace.owner_id || workspace.created_by || '') === String(user.id);
		const memberAllowed = membership?.mcp_enabled === true;
		if (!ownsWorkspace && !memberAllowed) return [];
		return [{
			...workspace,
			permission: ownsWorkspace ? 'owner' : String(membership?.role || 'viewer'),
			management_permissions: { mcp_use: true }
		}];
	});
}

async function accessWorkspaces(user: OrbitUser, engineId: string) {
	const workspaces = await visibleWorkspaces(user);
	if (isSystemAdmin(user)) return workspaces;
	if (engineId === 'mcp') return mcpWorkspaceAccess(user);
	return workspaces.filter((workspace: any) => workspaceAllowsEngine(workspace, engineId));
}

export async function engineAccess(user: OrbitUser, engineId: string): Promise<EngineAccess> {
	const admin = isSystemAdmin(user);
	const workspaces = await accessWorkspaces(user, engineId);
	return { allowed: admin || workspaces.length > 0, admin, workspaces };
}

export async function engineCatalogAccess(user: OrbitUser, engines: any[]) {
	const admin = isSystemAdmin(user);
	if (admin) {
		const workspaces = await visibleWorkspaces(user);
		return engines.map((engine: any) => ({
			...engine,
			accessAllowed: true,
			accessWorkspaceCount: workspaces.length,
			accessWorkspaceNames: workspaces.map((workspace: any) => String(workspace.name || workspace.id)).slice(0, 8)
		}));
	}

	const [mcpWorkspaces, normalWorkspaces] = await Promise.all([
		mcpWorkspaceAccess(user),
		visibleWorkspaces(user)
	]);
	return engines
		.map((engine: any) => {
			const allowedWorkspaces = engine.id === 'mcp'
				? mcpWorkspaces
				: normalWorkspaces.filter((workspace: any) => workspaceAllowsEngine(workspace, engine.id));
			return {
				...engine,
				accessAllowed: allowedWorkspaces.length > 0,
				accessWorkspaceCount: allowedWorkspaces.length,
				accessWorkspaceNames: allowedWorkspaces.map((workspace: any) => String(workspace.name || workspace.id)).slice(0, 8)
			};
		})
		.filter((engine: any) => engine.accessAllowed);
}
