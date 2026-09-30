import { getSupabaseAdmin } from '$lib/server/supabase';
import { getSharedEngineHostState } from '$lib/server/shared-engine-host';
import { getApexExecutionPolicy } from '$lib/server/apex-policy';
import { componentLicensed, getPanelLicenseSummary } from '$lib/server/license';

export type EngineMode = 'running'|'standby'|'stopped';
export type EngineSetupState = 'not_started'|'required'|'in_progress'|'complete'|'error';

const BUILTIN_ENGINE_COMPONENTS:Record<string,string>={mcp:'orbitfs_mcp',apex:'orbitfs_apex',studio:'orbitfs_studio'};
const ENGINE_STATE_CACHE_MS=2_000;
const engineStateCache=new Map<string,{expiresAt:number;value:any}>();
const engineStatePromises=new Map<string,Promise<any>>();

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function resolveSetupState(data:any,runtime:Record<string,any>,config:Record<string,any>):EngineSetupState {
	const setup=objectValue(config.engineSetup);
	const candidate=String(runtime.setupState||setup.state||'');
	if((['not_started','required','in_progress','complete','error'] as string[]).includes(candidate)) return candidate as EngineSetupState;
	if(data.attached===true) return 'required';
	return 'not_started';
}

function resolveEngineMode(addonId:string,runtime:Record<string,any>):EngineMode {
	const raw=(['running','standby','stopped'] as string[]).includes(String(runtime.engineMode))?String(runtime.engineMode) as EngineMode:null;
	if(addonId==='mcp') return raw==='stopped'?'stopped':'running';
	return raw||'standby';
}

function timestamp(value:unknown){
	const parsed=Date.parse(String(value||''));
	return Number.isFinite(parsed)?parsed:0;
}

async function resolveApexRuntimeMode(runtime:Record<string,any>,baseMode:EngineMode):Promise<EngineMode>{
	if(baseMode==='stopped')return 'stopped';
	const policy=await getApexExecutionPolicy().catch(()=>null);
	if(!policy||policy.standby===false)return 'running';
	const idleTimeout=Math.max(5_000,Number(policy.idleTimeoutMs||10_000));
	const requestAt=timestamp(runtime.lastRequestAt);
	const controlAt=timestamp(runtime.lastControlAt);
	const current=Date.now();
	if(baseMode==='standby'){
		if(requestAt>controlAt&&current-requestAt<idleTimeout)return 'running';
		return 'standby';
	}
	const lastActivity=Math.max(requestAt,controlAt);
	if(lastActivity>0&&current-lastActivity>=idleTimeout)return 'standby';
	return 'running';
}

async function computeAddonEngineState(addonId:string) {
	const db=getSupabaseAdmin();
	const [{data,error},host,license]=await Promise.all([
		db.from('orbitfs_addons').select('id,name,runtime,config,installed,attached,configured,available,license_component,updated_at').eq('id',addonId).maybeSingle(),
		getSharedEngineHostState(),
		getPanelLicenseSummary()
	]);
	if(error) throw error;
	if(!data) throw Object.assign(new Error('Unknown add-on engine'),{status:404,code:'ENGINE_NOT_FOUND'});
	const runtime=objectValue(data.runtime),config=objectValue(data.config),link=objectValue(config.engineHostLink);
	let mode=resolveEngineMode(addonId,runtime);
	if(addonId==='apex')mode=await resolveApexRuntimeMode(runtime,mode);
	const setupState=resolveSetupState(data,runtime,config);
	const hostLinked=['linked','ready'].includes(host.state)&&Boolean(host.panelUrl)&&Boolean(host.hostUrl);
	const licenseComponent=String(data.license_component||BUILTIN_ENGINE_COMPONENTS[addonId]||'');
	const component=licenseComponent?objectValue(license.components?.[licenseComponent]):{};
	const licensed=license.licensed===true&&Boolean(licenseComponent)&&componentLicensed(component);
	return {
		addonId:data.id,name:data.name,mode,setupState,setupVersion:Number(runtime.setupVersion||1),
		linked:hostLinked&&data.attached===true&&String(link.state||'linked')==='linked',hostLinked,hostState:host.state,
		linkState:String(link.state||'unlinked'),panelUrl:host.panelUrl||link.panelUrl||runtime.panelUrl||null,
		hostUrl:host.hostUrl||link.hostUrl||runtime.hostUrl||null,workspaceId:link.workspaceId||runtime.workspaceId||null,
		workspaceName:link.workspaceName||null,installationId:host.installationId||link.installationId||null,
		generation:Number(runtime.generation||1),lastRequestAt:runtime.lastRequestAt||null,lastControlAt:runtime.lastControlAt||null,
		lastControlBy:runtime.lastControlBy||null,lastLinkSyncAt:runtime.lastLinkSyncAt||link.lastSyncAt||host.lastSyncAt||null,
		lastError:runtime.lastError||null,deployment:runtime.deployment||'ready',transport:runtime.transport||(addonId==='mcp'?'/mcp':null),
		compute:runtime.compute||'vercel',database:runtime.database||'shared-panel',installed:data.installed===true,attached:data.attached===true,
		configured:setupState==='complete'&&data.configured===true,available:data.available!==false,licensed,licenseComponent,
		licenseState:String(component.state||'not_included'),licenseReason:component.reason?String(component.reason):licensed?null:'not_included',updatedAt:data.updated_at||null
	};
}

export async function getAddonEngineState(addonId:string,force=false) {
	const key=String(addonId).toLowerCase(),cached=engineStateCache.get(key);
	if(!force&&cached&&cached.expiresAt>Date.now())return cached.value;
	if(!force&&engineStatePromises.has(key))return engineStatePromises.get(key)!;
	const promise=computeAddonEngineState(key);
	if(!force)engineStatePromises.set(key,promise);
	try{const value=await promise;engineStateCache.set(key,{expiresAt:Date.now()+ENGINE_STATE_CACHE_MS,value});return value;}
	finally{engineStatePromises.delete(key);}
}

export async function assertAddonEngineLicensed(addonId:string){
	const state=await getAddonEngineState(addonId);
	if(!state.licensed)throw Object.assign(new Error(`This OrbitFS installation is not licensed for ${state.name||addonId}`),{status:403,code:'LICENSE_REQUIRED'});
	return state;
}

export async function setAddonEngineMode(addonId:string,action:EngineMode|'restart',actor:string|null=null){
	if(addonId==='mcp'&&action==='standby') throw Object.assign(new Error('OrbitFS MCP is request-driven and does not use Standby mode'),{status:400,code:'MCP_STANDBY_UNSUPPORTED'});
	const db=getSupabaseAdmin(),current=await assertAddonEngineLicensed(addonId);
	if(!current.installed) throw Object.assign(new Error(`OrbitFS ${addonId} engine is not installed`),{status:409,code:'ENGINE_NOT_INSTALLED'});
	if(!current.attached || !current.linked) throw Object.assign(new Error(`OrbitFS ${addonId} engine is not attached to the Shared Engine Host`),{status:409,code:'ENGINE_NOT_ATTACHED'});
	if(!current.configured) throw Object.assign(new Error(`Complete OrbitFS ${addonId} first-time setup before changing runtime mode`),{status:409,code:'ENGINE_SETUP_REQUIRED'});
	const stamp=new Date().toISOString(),nextMode:EngineMode=action==='restart'?'running':action;
	const {data:row,error:readError}=await db.from('orbitfs_addons').select('runtime').eq('id',addonId).maybeSingle();
	if(readError) throw readError;
	const runtime=objectValue(row?.runtime);
	const next={...runtime,engineMode:nextMode,generation:action==='restart'?current.generation+1:current.generation,lastControlAt:stamp,lastControlBy:actor,lastError:null,online:nextMode!=='stopped',deployment:'ready',compute:'vercel',database:'shared-panel'};
	const {error}=await db.from('orbitfs_addons').update({runtime:next,updated_at:stamp}).eq('id',addonId);
	if(error) throw error;
	engineStateCache.delete(String(addonId).toLowerCase());
	return getAddonEngineState(addonId,true);
}

export async function noteAddonRequest(addonId:string){
	const db=getSupabaseAdmin();
	await db.rpc('orbitfs_touch_addon_request',{p_addon_id:addonId,p_min_interval_seconds:30});
}

export async function assertAddonEngineAccepting(addonId:string,options:{requireSetup?:boolean}={}){
	const state=await assertAddonEngineLicensed(addonId);
	if(!state.hostLinked) throw Object.assign(new Error('Shared Engine Host is not linked to OrbitFS Panel'),{status:503,code:'ENGINE_HOST_NOT_LINKED'});
	if(!state.installed || !state.attached || !state.linked) throw Object.assign(new Error(`OrbitFS ${addonId} engine is not attached`),{status:503,code:'ENGINE_NOT_ATTACHED'});
	if(options.requireSetup!==false && !state.configured) throw Object.assign(new Error(`OrbitFS ${addonId} first-time setup is not complete`),{status:503,code:'ENGINE_SETUP_REQUIRED'});
	if(!state.available) throw Object.assign(new Error(`OrbitFS ${addonId} engine is unavailable`),{status:503,code:'ENGINE_UNAVAILABLE'});
	if(state.mode==='stopped') throw Object.assign(new Error(`OrbitFS ${addonId} engine is stopped`),{status:503,code:'ENGINE_STOPPED'});
	return state;
}
