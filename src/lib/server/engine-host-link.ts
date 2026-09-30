import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { componentLicensed, ensureInstallationIdentity, getPanelLicenseSummary } from '$lib/server/license';
import { assertSharedEngineHostLinked, getSharedEngineHostState } from '$lib/server/shared-engine-host';

export type EngineSetupState = 'not_started' | 'required' | 'in_progress' | 'complete' | 'error';

const COMPONENTS: Record<string, string> = { mcp: 'orbitfs_mcp', apex: 'orbitfs_apex', studio: 'orbitfs_studio' };

function safeEqual(a: string, b: string) {
	const aa = Buffer.from(a);
	const bb = Buffer.from(b);
	return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function engineSecret() {
	return String(env.ORBITFS_ENGINE_SECRET || env.ORBITFS_DB_SECRET || '').trim();
}

export function authorizeEngineHostRequest(request: Request, rawBody = '') {
	const expected = engineSecret();
	if (!expected) return false;
	const supplied = String(request.headers.get('x-orbitfs-engine-secret') || '');
	if (!safeEqual(supplied, expected)) return false;
	const timestamp = String(request.headers.get('x-orbitfs-timestamp') || '').trim();
	const signature = String(request.headers.get('x-orbitfs-signature') || '').trim();
	if (!timestamp && !signature) return true;
	if (!timestamp || !signature) return false;
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds) || Math.abs(Date.now() - seconds * 1000) > 5 * 60 * 1000) return false;
	const expectedSignature = createHmac('sha256', expected).update(`${timestamp}.${rawBody}`).digest('hex');
	return safeEqual(signature, expectedSignature);
}

function normalizeEngineId(value: unknown) {
	const id = String(value || '').trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw Object.assign(new Error('Invalid engine id'), { status: 400, code: 'ENGINE_ID_INVALID' });
	return id;
}

async function getEngineRow(engineId: string) {
	const db = getSupabaseAdmin();
	const { data, error } = await db.from('orbitfs_addons').select('id,name,installed,attached,configured,available,license_component,config,runtime,updated_at').eq('id', engineId).maybeSingle();
	if (error) throw error;
	if (!data) throw Object.assign(new Error('Unknown engine'), { status: 404, code: 'ENGINE_NOT_FOUND' });
	return data as any;
}

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function setupStateFor(row: any): EngineSetupState {
	const runtime = objectValue(row.runtime);
	const setup = objectValue(objectValue(row.config).engineSetup);
	const candidate = String(runtime.setupState || setup.state || '');
	if (['not_started','required','in_progress','complete','error'].includes(candidate)) return candidate as EngineSetupState;
	return row.attached === true ? 'required' : 'not_started';
}

function engineModeFor(engineId:string,runtime:Record<string,any>) {
	const raw=String(runtime.engineMode||'');
	if(engineId==='mcp') return raw==='stopped'?'stopped':'running';
	return ['running','standby','stopped'].includes(raw)?raw:'standby';
}

async function licenseStatus(engineId: string, row: any) {
	const componentId = String(row.license_component || COMPONENTS[engineId] || '').trim() || null;
	if (!componentId) return { componentId: null, licensed: true, component: null };
	const summary = await getPanelLicenseSummary();
	const component = summary.components?.[componentId] || null;
	return { componentId, licensed: summary.licensed === true && componentLicensed(component || {}), component };
}

export async function getEngineHostLink(engineIdInput: unknown) {
	const engineId = normalizeEngineId(engineIdInput);
	const [row, host] = await Promise.all([getEngineRow(engineId), getSharedEngineHostState()]);
	const config = objectValue(row.config);
	const runtime = objectValue(row.runtime);
	const link = objectValue(config.engineHostLink);
	const license = await licenseStatus(engineId, row);
	const setupState = setupStateFor(row);
	const hostLinked = ['linked','ready'].includes(host.state);
	return {
		engineId,
		name: row.name,
		installed: row.installed === true,
		attached: row.attached === true,
		configured: setupState === 'complete' && row.configured === true,
		available: row.available !== false,
		setupState,
		setupVersion: Number(runtime.setupVersion || 1),
		engineState: engineModeFor(engineId,runtime),
		linked: hostLinked && row.attached === true && link.state === 'linked',
		hostLinked,
		hostState: host.state,
		linkState: String(link.state || (row.attached ? 'linked' : 'unlinked')),
		installationId: host.installationId,
		panelUrl: host.panelUrl,
		hostUrl: host.hostUrl,
		workspaceId: link.workspaceId || runtime.workspaceId || null,
		workspaceName: link.workspaceName || null,
		linkedByUserId: link.linkedByUserId || null,
		linkedByUsername: link.linkedByUsername || null,
		linkedAt: link.linkedAt || null,
		lastSyncAt: link.lastSyncAt || host.lastSyncAt || null,
		detachedAt: link.detachedAt || null,
		componentId: license.componentId,
		licensed: license.licensed,
		licenseComponent: license.component,
		updatedAt: row.updated_at || null
	};
}

export async function pairEngineHost(input: Record<string, any>) {
	const host = await assertSharedEngineHostLinked();
	const engineId = normalizeEngineId(input.engineId || input.engine_id);
	const row = await getEngineRow(engineId);
	if (row.installed !== true) throw Object.assign(new Error(`OrbitFS ${engineId} must be installed from Panel before it can be attached`), { status: 409, code: 'ENGINE_NOT_INSTALLED' });
	const installationId = String(input.installationId || input.installation_id || '').trim();
	const canonicalInstallationId = await ensureInstallationIdentity();
	if (!installationId || installationId !== canonicalInstallationId || host.installationId !== canonicalInstallationId) {
		throw Object.assign(new Error('Engine attachment belongs to a different OrbitFS installation'), { status: 409, code: 'INSTALLATION_MISMATCH' });
	}
	const panelUrl = String(input.panelUrl || input.panel_url || '').trim().replace(/\/$/, '');
	if (!panelUrl || panelUrl !== host.panelUrl) throw Object.assign(new Error('Engine attachment does not match the linked OrbitFS Panel'), { status: 409, code: 'PANEL_URL_MISMATCH' });
	const workspaceId = String(input.workspaceId || input.workspace_id || '').trim();
	if (!workspaceId) throw Object.assign(new Error('Workspace id is required'), { status: 400, code: 'WORKSPACE_REQUIRED' });
	const db = getSupabaseAdmin();
	const { data: workspace, error: workspaceError } = await db.from('orbitfs_workspaces').select('id,name,is_main').eq('id', workspaceId).maybeSingle();
	if (workspaceError) throw workspaceError;
	if (!workspace) throw Object.assign(new Error('Workspace was not found in the shared OrbitFS backend'), { status: 404, code: 'WORKSPACE_NOT_FOUND' });
	const actorUserId = String(input.actorUserId || input.actor_user_id || '').trim() || null;
	let actor: any = null;
	if (actorUserId) {
		const result = await db.from('orbitfs_users').select('id,username,display_name,status').eq('id', actorUserId).maybeSingle();
		if (result.error) throw result.error;
		if (!result.data || result.data.status !== 'active') throw Object.assign(new Error('Attaching user is not an active OrbitFS user'), { status: 403, code: 'PAIRING_USER_INVALID' });
		actor = result.data;
	}
	const license = await licenseStatus(engineId, row);
	if (!license.licensed) throw Object.assign(new Error(`OrbitFS ${engineId} is not licensed for this installation`), { status: 403, code: 'ENGINE_LICENSE_REQUIRED' });

	const config = objectValue(row.config);
	const runtime = objectValue(row.runtime);
	const previousLink = objectValue(config.engineHostLink);
	const previousSetup = objectValue(config.engineSetup);
	const previousSetupState = setupStateFor(row);
	const stamp = new Date().toISOString();
	const automaticMcp = engineId === 'mcp';
	const setupState: EngineSetupState = automaticMcp ? 'complete' : previousSetupState === 'complete' ? 'complete' : 'required';
	const engineSetup = {
		...previousSetup,
		state: setupState,
		version: Number(runtime.setupVersion || 1),
		updatedAt: stamp,
		updatedByUserId: actor?.id || null,
		...(automaticMcp ? {
			automatic: true,
			configurationReviewedAt: previousSetup.configurationReviewedAt || stamp,
			configurationReviewedByUserId: previousSetup.configurationReviewedByUserId || actor?.id || null
		} : {})
	};
	const link = {
		version: 2,
		state: 'linked',
		engineId,
		componentId: license.componentId,
		installationId,
		panelUrl: host.panelUrl,
		hostUrl: host.hostUrl,
		workspaceId: workspace.id,
		workspaceName: workspace.name,
		workspaceIsMain: workspace.is_main === true,
		linkedByUserId: actor?.id || previousLink.linkedByUserId || null,
		linkedByUsername: actor?.username || previousLink.linkedByUsername || null,
		linkedAt: previousLink.linkedAt || stamp,
		lastSyncAt: stamp,
		detachedAt: null
	};
	const nextRuntime = {
		...runtime,
		engineHostLinked: true,
		panelUrl: host.panelUrl,
		hostUrl: host.hostUrl,
		workspaceId: workspace.id,
		setupState,
		setupVersion: engineSetup.version,
		lastLinkSyncAt: stamp,
		deployment: 'ready',
		compute: 'vercel',
		database: 'supabase',
		transport: engineId === 'mcp' ? '/mcp' : (runtime.transport || null),
		online: automaticMcp ? true : runtime.online === true,
		engineMode: engineId === 'mcp' ? 'running' : engineModeFor(engineId,runtime)
	};
	const { error } = await db.from('orbitfs_addons').update({
		attached: true,
		configured: setupState === 'complete',
		status: 'attached',
		config: { ...config, engineHostLink: link, engineSetup },
		runtime: nextRuntime,
		updated_at: stamp
	}).eq('id', engineId);
	if (error) throw error;
	return getEngineHostLink(engineId);
}

export async function detachEngineHost(engineIdInput: unknown, actorUserId?: string | null) {
	await assertSharedEngineHostLinked();
	const engineId = normalizeEngineId(engineIdInput);
	const row = await getEngineRow(engineId);
	const config = objectValue(row.config);
	const runtime = objectValue(row.runtime);
	const previousLink = objectValue(config.engineHostLink);
	const stamp = new Date().toISOString();
	const nextLink = { ...previousLink, state: 'detached', lastSyncAt: stamp, detachedAt: stamp, detachedByUserId: actorUserId || null };
	const db = getSupabaseAdmin();
	const { error } = await db.from('orbitfs_addons').update({
		attached: false,
		status: 'detached',
		config: { ...config, engineHostLink: nextLink },
		runtime: { ...runtime, engineHostLinked: false, online: false, lastLinkSyncAt: stamp },
		updated_at: stamp
	}).eq('id', engineId);
	if (error) throw error;
	return getEngineHostLink(engineId);
}
