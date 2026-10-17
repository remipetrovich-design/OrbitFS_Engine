import { env } from '$env/dynamic/private';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { ensureInstallationIdentity } from '$lib/server/license';
import {
	configuredEngineHostUrl,
	configuredPanelUrl,
	getSharedEngineHostState,
	resolvedSharedEngineHostUrl
} from '$lib/server/engine-host-state';

export type EngineMode = 'running' | 'standby' | 'stopped';

type EngineState = {
	addonId: string;
	name: string;
	mode: EngineMode;
	setupState: string;
	linked: boolean;
	generation: number;
	lastRequestAt: string | null;
	lastControlAt: string | null;
	lastControlBy: string | null;
	lastError: string | null;
	deployment: string;
	transport: string | null;
	compute: string;
	database: string;
	installed: boolean;
	attached: boolean;
	configured: boolean;
	available: boolean;
	updatedAt: string | null;
};

function runtimeOf(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function engineHostBaseUrl() {
	const configured = configuredEngineHostUrl();
	if (!configured) {
		throw Object.assign(new Error('This OrbitFS installation does not have an Engine Host configured.'), {
			status: 409,
			code: 'ENGINE_HOST_NOT_CONFIGURED'
		});
	}
	return configured;
}

export async function resolvedEngineHostBaseUrl() {
	return resolvedSharedEngineHostUrl();
}

export function panelBaseUrl() {
	return configuredPanelUrl();
}

async function parseEngineHostResponse(response: Response) {
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw Object.assign(new Error(body?.error || body?.message || `Engine Host returned ${response.status}`), {
			status: response.status < 500 ? response.status : 503,
			code: body?.code || 'ENGINE_HOST_REQUEST_FAILED'
		});
	}
	return body;
}

async function mainWorkspace() {
	const db = getSupabaseAdmin();
	let result = await db.from('orbitfs_workspaces').select('id,name,is_main,status').eq('is_main', true).neq('status', 'archived').limit(1).maybeSingle();
	if (result.error) throw result.error;
	if (!result.data) {
		result = await db.from('orbitfs_workspaces').select('id,name,is_main,status').neq('status', 'archived').order('created_at', { ascending: true }).limit(1).maybeSingle();
		if (result.error) throw result.error;
	}
	if (!result.data) throw Object.assign(new Error('OrbitFS has no workspace available for Engine Host attachment'), { status: 409, code: 'WORKSPACE_REQUIRED' });
	return result.data;
}

export async function getEngineAttachContext(engineId: string, actorUserId: string) {
	const host = await getSharedEngineHostState();
	if (!['linked','ready'].includes(host.state) || !host.hostUrl) {
		throw Object.assign(new Error('Link the Shared Engine Host before attaching an engine.'), { status: 409, code: 'ENGINE_HOST_NOT_LINKED' });
	}
	const db = getSupabaseAdmin();
	const workspace = await mainWorkspace();
	const { data: row, error: rowError } = await db.from('orbitfs_addons').select('id,name,installed,runtime').eq('id', engineId).maybeSingle();
	if (rowError) throw rowError;
	const pendingInstall=runtimeOf(row?.runtime).pendingInstall===true;
	if (!row || (row.installed !== true && !pendingInstall)) {
		throw Object.assign(new Error('Install the engine or start its pending installation before attaching it'), { status: 409, code: 'ENGINE_NOT_INSTALLED' });
	}
	const { data: actor, error: actorError } = await db.from('orbitfs_users').select('id,username,status').eq('id', actorUserId).maybeSingle();
	if (actorError) throw actorError;
	if (!actor || actor.status !== 'active') {
		throw Object.assign(new Error('Attaching user is not an active OrbitFS user'), { status: 403, code: 'PAIRING_USER_INVALID' });
	}
	return {
		engineId,
		installationId: await ensureInstallationIdentity(),
		panelUrl: host.panelUrl || panelBaseUrl(),
		workspaceId: String(workspace.id),
		workspaceName: String(workspace.name || ''),
		actorUserId: String(actor.id),
		actorUsername: String(actor.username || ''),
		hostUrl: host.hostUrl
	};
}

export async function pairWithEngineHost(engineId: string, actorUserId: string) {
	const state = await getEngineAttachContext(engineId, actorUserId);
	return { ok: true, action: 'prepare_attach', state };
}

export async function detachFromEngineHost(engineId: string, actorUserId: string) {
	return { ok: true, action: 'prepare_detach', actorUserId, state: await getEngineStatus(engineId) };
}

export async function getRemoteEngineLink(engineId: string) {
	const response = await fetch(`${await resolvedEngineHostBaseUrl()}/health`, {
		signal: AbortSignal.timeout(Number(env.ORBITFS_ENGINE_TIMEOUT_MS || 8000)),
		cache: 'no-store'
	});
	const health = await parseEngineHostResponse(response);
	return { ...health, engineId };
}

export async function getEngineStatus(addonId: string): Promise<EngineState> {
	const db = getSupabaseAdmin();
	const [{ data, error }, host] = await Promise.all([
		db.from('orbitfs_addons').select('id,name,runtime,config,installed,attached,configured,available,updated_at').eq('id', addonId).maybeSingle(),
		getSharedEngineHostState()
	]);
	if (error) throw error;
	if (!data) throw Object.assign(new Error('Unknown add-on engine'), { status: 404, code: 'ENGINE_NOT_FOUND' });

	const runtime = runtimeOf(data.runtime);
	const config = runtimeOf(data.config);
	const setup = runtimeOf(config.engineSetup);
	const defaultMode: EngineMode = addonId === 'mcp' ? (data.attached === true ? 'running' : 'stopped') : 'standby';
	const rawMode = String(runtime.engineMode || defaultMode);
	let mode: EngineMode = ['running', 'standby', 'stopped'].includes(rawMode) ? rawMode as EngineMode : defaultMode;
	// MCP is request-driven/serverless. "Standby" has no application meaning;
	// normalize stale legacy rows instead of exposing a fake third state.
	if (addonId === 'mcp' && mode === 'standby') mode = 'running';
	const rawSetup = String(runtime.setupState || setup.state || (data.attached ? 'required' : 'not_started'));
	const setupState = ['not_started','required','in_progress','complete','error'].includes(rawSetup) ? rawSetup : 'not_started';
	const hostLinked = ['linked','ready'].includes(host.state);

	return {
		addonId: String(data.id),
		name: String(data.name || data.id),
		mode,
		setupState,
		linked: hostLinked && data.attached === true,
		generation: Number(runtime.generation || 1),
		lastRequestAt: runtime.lastRequestAt || null,
		lastControlAt: runtime.lastControlAt || null,
		lastControlBy: runtime.lastControlBy || null,
		lastError: runtime.lastError || null,
		deployment: String(runtime.deployment || 'ready'),
		transport: runtime.transport || (addonId === 'mcp' ? '/mcp' : null),
		compute: String(runtime.compute || 'vercel'),
		database: String(runtime.database || 'supabase'),
		installed: data.installed === true,
		attached: data.attached === true,
		configured: setupState === 'complete' && data.configured === true,
		available: data.available !== false,
		updatedAt: data.updated_at || null
	};
}

export async function controlEngine(addonId: string, action: 'running' | 'standby' | 'stopped' | 'restart', actor: string): Promise<EngineState> {
	if (addonId === 'mcp' && action === 'standby') {
		throw Object.assign(new Error('MCP does not use Standby. Use Running or Stopped.'), { status: 400, code: 'MCP_STANDBY_UNSUPPORTED' });
	}
	const db = getSupabaseAdmin();
	const current = await getEngineStatus(addonId);
	if (!current.linked || !current.attached) throw Object.assign(new Error('Attach the engine to the Shared Engine Host first.'), { status: 409, code: 'ENGINE_NOT_ATTACHED' });
	if (!current.configured && !(addonId === 'mcp' && action === 'running')) throw Object.assign(new Error('Complete engine setup before changing runtime mode.'), { status: 409, code: 'ENGINE_SETUP_REQUIRED' });
	const { data: row, error: readError } = await db.from('orbitfs_addons').select('runtime').eq('id', addonId).maybeSingle();
	if (readError) throw readError;
	const runtime = runtimeOf(row?.runtime);
	const stamp = new Date().toISOString();
	const nextMode: EngineMode = action === 'restart' ? 'running' : action;
	const nextRuntime = {
		...runtime,
		engineMode: nextMode,
		generation: action === 'restart' ? current.generation + 1 : current.generation,
		lastControlAt: stamp,
		lastControlBy: actor,
		lastError: null,
		online: nextMode !== 'stopped',
		deployment: 'ready',
		compute: 'vercel',
		database: 'supabase'
	};
	const { error } = await db.from('orbitfs_addons').update({ runtime: nextRuntime, updated_at: stamp }).eq('id', addonId);
	if (error) throw error;
	return getEngineStatus(addonId);
}