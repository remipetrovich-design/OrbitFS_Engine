import { getSupabaseAdmin } from '$lib/server/supabase';
import { getAddonEngineState, type EngineSetupState } from '$lib/server/addon-engine';
import { componentLicensed, getPanelLicenseSummary } from '$lib/server/license';
import { getSharedEngineHostState } from '$lib/server/shared-engine-host';
import { mcpAddonManifest } from '../../addons/mcp/manifest';
import { apexAddonManifest } from '../../addons/apex/manifest';
import { studioAddonManifest } from '../../addons/studio/manifest';

const ENGINE_MANIFESTS = [mcpAddonManifest, apexAddonManifest, studioAddonManifest] as const;

export const ENGINE_CATALOG = ENGINE_MANIFESTS.map((manifest) => ({
	id: manifest.id,
	name: manifest.id === 'mcp' ? 'MCP' : manifest.id === 'apex' ? 'APEX' : 'Studio',
	fullName: manifest.name,
	description: manifest.description,
	component: manifest.licenseComponent,
	version: manifest.version,
	transportPath: manifest.transportPath,
	sourceRef: manifest.sourceRef,
	manifest
})) as ReadonlyArray<{
	id:string;
	name:string;
	fullName:string;
	description:string;
	component:string;
	version:string;
	transportPath:string|null;
	sourceRef:string;
	manifest:any;
}>;

let builtinRecordsCheckedAt = 0;
const BUILTIN_CHECK_TTL_MS = 5 * 60 * 1000;

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function setupStateFor(row: any): EngineSetupState {
	const runtime = objectValue(row?.runtime);
	const config = objectValue(row?.config);
	const setup = objectValue(config.engineSetup);
	const state = String(runtime.setupState || setup.state || '');
	if (['not_started','required','in_progress','complete','error'].includes(state)) return state as EngineSetupState;
	return row?.attached ? 'required' : 'not_started';
}

function engineModeFor(engineId:string,runtime:Record<string,any>) {
	const raw=String(runtime.engineMode||'');
	if(engineId==='mcp') return raw==='stopped'?'stopped':'running';
	return ['running','standby','stopped'].includes(raw)?raw:'standby';
}

export function knownEngine(id: string) {
	return ENGINE_CATALOG.find((engine) => engine.id === id.toLowerCase()) || null;
}

export async function ensureBuiltinEngineRecords(force = false) {
	if (!force && builtinRecordsCheckedAt && Date.now() - builtinRecordsCheckedAt < BUILTIN_CHECK_TTL_MS) return;
	const db=getSupabaseAdmin();
	const ids=ENGINE_CATALOG.map((engine)=>engine.id);
	const existing=await db.from('orbitfs_addons').select('id').in('id',ids);
	if(existing.error)throw existing.error;
	const present=new Set((existing.data||[]).map((row:any)=>String(row.id)));
	const missing=ENGINE_CATALOG.filter((engine)=>!present.has(engine.id));
	if(missing.length){
		const rows=missing.map((engine)=>({
			id:engine.id,
			name:engine.fullName,
			description:engine.description,
			version:engine.version,
			license_component:engine.component,
			available:true,
			installed:false,
			attached:false,
			configured:false,
			status:'registered',
			deployment_url:null,
			transport_path:engine.transportPath,
			source_ref:engine.sourceRef,
			config:{},
			manifest:engine.manifest,
			runtime:{mode:'engine-host',engineMode:engine.id==='mcp'?'running':'standby',setupState:'not_started',compute:'vercel',database:'shared-panel',online:false},
			installed_at:null
		}));
		const result=await db.from('orbitfs_addons').upsert(rows,{onConflict:'id',ignoreDuplicates:true});
		if(result.error)throw result.error;
	}

	// Engine owns the add-on manifest. Reconcile only catalog/manifest fields on
	// existing rows so Panel never becomes the source of truth for Engine UI.
	for(const engine of ENGINE_CATALOG){
		const reconciled=await db.from('orbitfs_addons').update({
			name:engine.fullName,
			description:engine.description,
			version:engine.version,
			license_component:engine.component,
			available:true,
			transport_path:engine.transportPath,
			source_ref:engine.sourceRef,
			manifest:engine.manifest,
			updated_at:new Date().toISOString()
		}).eq('id',engine.id);
		if(reconciled.error)throw reconciled.error;
	}
	builtinRecordsCheckedAt = Date.now();
}

export async function listEngineHubEngines() {
	await ensureBuiltinEngineRecords();
	const db = getSupabaseAdmin();
	const ids=ENGINE_CATALOG.map((engine)=>engine.id);
	const [{ data: rows, error }, license, host] = await Promise.all([
		db.from('orbitfs_addons').select('id,name,installed,attached,configured,available,license_component,config,runtime,updated_at').in('id',ids),
		getPanelLicenseSummary(),
		getSharedEngineHostState()
	]);
	if (error) throw error;
	const hostLinked = ['linked','ready'].includes(host.state) && Boolean(host.panelUrl) && Boolean(host.hostUrl);
	const byId = new Map((rows || []).map((row: any) => [String(row.id), row]));
	return ENGINE_CATALOG.map((engine) => {
		const row: any = byId.get(engine.id) || null;
		const runtime = objectValue(row?.runtime);
		const config = objectValue(row?.config);
		const setup = objectValue(config.engineSetup);
		const link = objectValue(config.engineHostLink);
		const componentId = String(row?.license_component || engine.component);
		const component = objectValue(license.components?.[componentId]);
		const licensed = license.licensed === true && componentLicensed(component);
		const setupState = setupStateFor(row);
		return {
			...engine,
			component: componentId,
			registered: Boolean(row),
			installed: row?.installed === true,
			attached: row?.attached === true,
			licensed,
			licenseState: String(component.state || 'not_included'),
			licenseAllowed: license.licensed === true && component.allowed === true,
			licenseLockedToInstallation: licensed,
			licenseReason: component.reason ? String(component.reason) : licensed ? null : 'not_included',
			available: row?.available !== false,
			configured: licensed && setupState === 'complete' && row?.configured === true,
			setupState,
			setupVersion: Number(runtime.setupVersion || 1),
			configurationReviewedAt: setup.configurationReviewedAt || null,
			configurationReviewedByUserId: setup.configurationReviewedByUserId || null,
			engineState: licensed ? engineModeFor(engine.id,runtime) : 'locked',
			linked: licensed && hostLinked && row?.attached === true && String(link.state || 'linked') === 'linked',
			hostLinked,
			hostState: host.state,
			panelUrl: licensed ? (host.panelUrl || link.panelUrl || runtime.panelUrl || null) : null,
			hostUrl: licensed ? (host.hostUrl || link.hostUrl || runtime.hostUrl || null) : null,
			workspaceId: licensed ? (link.workspaceId || runtime.workspaceId || null) : null,
			workspaceName: licensed ? (link.workspaceName || null) : null,
			lastSyncAt: licensed ? (runtime.lastLinkSyncAt || link.lastSyncAt || host.lastSyncAt || null) : null,
			updatedAt: row?.updated_at || null
		};
	});
}

export async function getEngineHubEngine(id: string) {
	const engine = knownEngine(id);
	if (!engine) throw Object.assign(new Error('Unknown engine'), { status: 404, code: 'ENGINE_NOT_FOUND' });
	const list = await listEngineHubEngines();
	const summary = list.find((item) => item.id === engine.id)!;
	if (!summary.registered || !summary.licensed) return { ...summary, state: null };
	return { ...summary, state: await getAddonEngineState(engine.id) };
}

export async function setEngineSetupState(engineId: string, setupState: EngineSetupState, actorUserId: string) {
	const engine = knownEngine(engineId);
	if (!engine) throw Object.assign(new Error('Unknown engine'), { status: 404, code: 'ENGINE_NOT_FOUND' });
	if (!['not_started','required','in_progress','complete','error'].includes(setupState)) throw Object.assign(new Error('Invalid setup state'), { status: 400, code: 'SETUP_STATE_INVALID' });
	const current=await getEngineHubEngine(engine.id);
	if(!current.licensed)throw Object.assign(new Error('This engine is not licensed for the current OrbitFS installation'),{status:403,code:'LICENSE_REQUIRED'});
	const db = getSupabaseAdmin();
	const { data: row, error: readError } = await db.from('orbitfs_addons').select('runtime,config,attached').eq('id', engine.id).maybeSingle();
	if (readError) throw readError;
	if (!row) throw Object.assign(new Error('Engine is not registered'), { status: 404, code: 'ENGINE_NOT_REGISTERED' });
	const runtime = objectValue(row.runtime);
	const config = objectValue(row.config);
	const stamp = new Date().toISOString();
	const configured = setupState === 'complete';
	const setup: Record<string, any> = { ...objectValue(config.engineSetup), state: setupState, version: Number(runtime.setupVersion || 1), updatedAt: stamp, updatedByUserId: actorUserId };
	if (setupState === 'required' || setupState === 'not_started') {
		setup.configurationReviewedAt = null;
		setup.configurationReviewedByUserId = null;
	}
	const { error } = await db.from('orbitfs_addons').update({
		configured,
		status: row.attached ? 'attached' : 'detached',
		config: { ...config, engineSetup: setup },
		runtime: { ...runtime, setupState, setupVersion: setup.version, lastSetupAt: stamp, lastSetupBy: actorUserId, online: configured ? runtime.online !== false : false },
		updated_at: stamp
	}).eq('id', engine.id);
	if (error) throw error;
	return getEngineHubEngine(engine.id);
}

export async function markEngineConfigurationReviewed(engineId: string, actorUserId: string) {
	const engine = knownEngine(engineId);
	if (!engine) throw Object.assign(new Error('Unknown engine'), { status: 404, code: 'ENGINE_NOT_FOUND' });
	const current=await getEngineHubEngine(engine.id);
	if(!current.licensed)throw Object.assign(new Error('This engine is not licensed for the current OrbitFS installation'),{status:403,code:'LICENSE_REQUIRED'});
	const db = getSupabaseAdmin();
	const { data: row, error: readError } = await db.from('orbitfs_addons').select('runtime,config,installed,attached').eq('id', engine.id).maybeSingle();
	if (readError) throw readError;
	if (!row) throw Object.assign(new Error('Engine is not registered'), { status: 404, code: 'ENGINE_NOT_REGISTERED' });
	if (row.installed !== true || row.attached !== true) throw Object.assign(new Error('Attach the engine from Panel before reviewing setup configuration'), { status: 409, code: 'ENGINE_NOT_ATTACHED' });
	const runtime = objectValue(row.runtime);
	const config = objectValue(row.config);
	const stamp = new Date().toISOString();
	const setup = {
		...objectValue(config.engineSetup),
		state: setupStateFor(row) === 'complete' ? 'complete' : 'in_progress',
		version: Number(runtime.setupVersion || 1),
		configurationReviewedAt: stamp,
		configurationReviewedByUserId: actorUserId,
		updatedAt: stamp,
		updatedByUserId: actorUserId
	};
	const { error } = await db.from('orbitfs_addons').update({
		configured: setup.state === 'complete',
		status: 'attached',
		config: { ...config, engineSetup: setup },
		runtime: { ...runtime, setupState: setup.state, setupVersion: setup.version, lastSetupAt: stamp, lastSetupBy: actorUserId },
		updated_at: stamp
	}).eq('id', engine.id);
	if (error) throw error;
	return getEngineHubEngine(engine.id);
}