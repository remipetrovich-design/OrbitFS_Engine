import { env } from '$env/dynamic/private';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { ensureInstallationIdentity } from '$lib/server/license';

export type SharedEngineHostStateName = 'not_deployed'|'provisioning'|'deployed'|'linking'|'linked'|'ready'|'error';
export type SharedEngineHostState = {
	version: 1; state: SharedEngineHostStateName; provider: 'vercel'; installationId: string;
	panelUrl: string | null; hostUrl: string | null; projectId: string | null; projectName: string | null;
	deploymentId: string | null; deploymentUrl: string | null; linkedAt: string | null; linkedByUserId: string | null;
	lastSyncAt: string | null; lastHealthAt: string | null; lastError: string | null; createdAt: string; updatedAt: string;
};

const SETTING_KEY = 'engine_host.shared';
const STATE_CACHE_MS = 10_000;
const now = () => new Date().toISOString();
let stateCache: { value: SharedEngineHostState; expiresAt: number } | null = null;
let statePromise: Promise<SharedEngineHostState> | null = null;

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function publicUrl(value: unknown, label: string) {
	try {
		const parsed = new URL(String(value || '').trim());
		const host = parsed.hostname.toLowerCase();
		if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
		if (['localhost','127.0.0.1','::1'].includes(host)) throw new Error();
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		throw Object.assign(new Error(`${label} must be a public HTTPS URL`), { status: 400, code: 'PUBLIC_URL_REQUIRED' });
	}
}

function runtimeHostUrl() {
	const explicit = String(env.ORBITFS_ENGINE_HOST_URL || '').trim();
	if (explicit) return publicUrl(explicit, 'Engine Host URL');
	const host = String(env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || '').trim();
	return host ? publicUrl(host.startsWith('http') ? host : `https://${host}`, 'Engine Host URL') : null;
}

async function computeSharedEngineHostState(): Promise<SharedEngineHostState> {
	const installationId = await ensureInstallationIdentity();
	const db = getSupabaseAdmin();
	const result = await db.from('orbitfs_settings').select('value').eq('scope_type','global').eq('scope_id','').eq('key',SETTING_KEY).maybeSingle();
	if (result.error) throw result.error;
	const stored = objectValue(result.data?.value);
	const storedInstallationId = String(stored.installationId || '').trim();
	if (storedInstallationId && storedInstallationId !== installationId) {
		throw Object.assign(new Error('Shared Engine Host state belongs to another OrbitFS installation.'), { status: 409, code: 'ENGINE_HOST_INSTALLATION_MISMATCH' });
	}
	const stamp = now(), runtimeHost = runtimeHostUrl();
	const storedHost = stored.hostUrl ? publicUrl(stored.hostUrl, 'Engine Host URL') : null;
	const runtimeProjectId = String(env.VERCEL_PROJECT_ID || '').trim(), storedProjectId = String(stored.projectId || '').trim();
	if (storedProjectId && runtimeProjectId && storedProjectId !== runtimeProjectId) {
		throw Object.assign(new Error('Shared Engine Host state belongs to another Engine project.'), { status: 409, code: 'ENGINE_HOST_DEPLOYMENT_MISMATCH' });
	}
	const hostUrl = storedHost || runtimeHost;
	const panelUrl = stored.panelUrl ? publicUrl(stored.panelUrl, 'Panel URL') : null;
	const valid: SharedEngineHostStateName[] = ['not_deployed','provisioning','deployed','linking','linked','ready','error'];
	const storedState = valid.includes(stored.state) ? stored.state as SharedEngineHostStateName : (hostUrl ? 'deployed' : 'not_deployed');
	return {
		// Preserve newer Base-managed deployment/updater fields that this Engine
		// version does not need to interpret itself.
		...stored,
		version:1,state:storedState,provider:'vercel',installationId,panelUrl,hostUrl,
		projectId:storedProjectId||runtimeProjectId||null,projectName:stored.projectName||String(env.VERCEL_PROJECT_NAME||'').trim()||null,
		deploymentId:stored.deploymentId||String(env.VERCEL_DEPLOYMENT_ID||'').trim()||null,deploymentUrl:stored.deploymentUrl||null,
		linkedAt:stored.linkedAt||null,linkedByUserId:stored.linkedByUserId||null,lastSyncAt:stored.lastSyncAt||null,
		lastHealthAt:stored.lastHealthAt||null,lastError:stored.lastError||null,createdAt:stored.createdAt||stamp,updatedAt:stored.updatedAt||stamp
	};
}

export async function getSharedEngineHostState(force=false): Promise<SharedEngineHostState> {
	if(!force&&stateCache&&stateCache.expiresAt>Date.now())return stateCache.value;
	if(!force&&statePromise)return statePromise;
	const promise=computeSharedEngineHostState();
	if(!force)statePromise=promise;
	try{const value=await promise;stateCache={value,expiresAt:Date.now()+STATE_CACHE_MS};return value;}
	finally{if(!force)statePromise=null;}
}

export async function saveSharedEngineHostState(patch: Partial<SharedEngineHostState>, knownCurrent?: SharedEngineHostState) {
	const current = knownCurrent || await getSharedEngineHostState();
	const stamp = now();
	const next: SharedEngineHostState = {
		...current,...patch,version:1,provider:'vercel',installationId:current.installationId,
		panelUrl:patch.panelUrl ? publicUrl(patch.panelUrl,'Panel URL') : current.panelUrl,
		hostUrl:patch.hostUrl ? publicUrl(patch.hostUrl,'Engine Host URL') : (current.hostUrl||runtimeHostUrl()),
		createdAt:current.createdAt||stamp,updatedAt:stamp
	};
	const db=getSupabaseAdmin();
	const result=await db.from('orbitfs_settings').upsert({scope_type:'global',scope_id:'',key:SETTING_KEY,value:next,updated_at:stamp},{onConflict:'scope_type,scope_id,key'});
	if(result.error)throw result.error;
	stateCache={value:next,expiresAt:Date.now()+STATE_CACHE_MS};
	return next;
}

function configuredPanelUrl() {
	const raw=String(env.ORBITFS_PANEL_URL||'').trim();
	return raw?publicUrl(raw,'Panel URL'):null;
}

async function normalizeAttachedMcp(actorUserId:string|null) {
	const db=getSupabaseAdmin();
	const result=await db.from('orbitfs_addons').select('config,runtime,installed,attached').eq('id','mcp').maybeSingle();
	if(result.error)throw result.error;
	const row:any=result.data;
	if(!row||row.installed!==true||row.attached!==true)return;
	const config=objectValue(row.config),runtime=objectValue(row.runtime),setup=objectValue(config.engineSetup),stamp=now();
	const version=Number(runtime.setupVersion||setup.version||1);
	const updated=await db.from('orbitfs_addons').update({
		configured:true,status:'attached',
		config:{...config,engineSetup:{...setup,state:'complete',version,automatic:true,configurationReviewedAt:setup.configurationReviewedAt||stamp,configurationReviewedByUserId:setup.configurationReviewedByUserId||actorUserId,updatedAt:stamp,updatedByUserId:actorUserId}},
		runtime:{...runtime,setupState:'complete',setupVersion:version,transport:'/mcp',deployment:'ready',compute:'vercel',database:'supabase',online:true,lastSetupAt:stamp,lastSetupBy:actorUserId},updated_at:stamp
	}).eq('id','mcp');
	if(updated.error)throw updated.error;
}

export async function linkSharedEngineHost(input:Record<string,any>) {
	const installationId=String(input.installationId||input.installation_id||'').trim();
	const current=await getSharedEngineHostState();
	if(!installationId||installationId!==current.installationId)throw Object.assign(new Error('Shared Engine Host link belongs to another OrbitFS installation.'),{status:409,code:'INSTALLATION_MISMATCH'});
	const panelUrl=publicUrl(input.panelUrl||input.panel_url,'Panel URL'),configuredPanel=configuredPanelUrl();
	if(configuredPanel&&configuredPanel!==panelUrl)throw Object.assign(new Error('Panel URL does not match the Engine Host configuration.'),{status:409,code:'PANEL_URL_MISMATCH'});
	if(['linked','ready'].includes(current.state)&&current.panelUrl&&current.panelUrl!==panelUrl)throw Object.assign(new Error('This Shared Engine Host is already linked to another OrbitFS Panel.'),{status:409,code:'ENGINE_HOST_ALREADY_LINKED'});
	const stamp=now(),actorUserId=String(input.actorUserId||input.actor_user_id||'').trim()||null;
	const linked=await saveSharedEngineHostState({state:'ready',panelUrl,hostUrl:current.hostUrl||runtimeHostUrl(),linkedAt:current.linkedAt||stamp,linkedByUserId:actorUserId||current.linkedByUserId,lastSyncAt:stamp,lastHealthAt:stamp,lastError:null},current);
	await normalizeAttachedMcp(actorUserId);
	return linked;
}

export async function unlinkSharedEngineHost(actorUserId?:string|null) {
	const db=getSupabaseAdmin();
	const attached=await db.from('orbitfs_addons').select('id,name').eq('attached',true).limit(20);
	if(attached.error)throw attached.error;
	if((attached.data||[]).length){const names=(attached.data||[]).map((row:any)=>String(row.name||row.id)).join(', ');throw Object.assign(new Error(`Detach all engines before unlinking the Shared Engine Host: ${names}`),{status:409,code:'ENGINE_HOST_ENGINES_ATTACHED'});}
	const current=await getSharedEngineHostState(),stamp=now();
	return saveSharedEngineHostState({state:current.hostUrl?'deployed':'not_deployed',panelUrl:current.panelUrl,linkedAt:null,linkedByUserId:actorUserId||null,lastSyncAt:stamp,lastError:null},current);
}

export async function touchSharedEngineHostHealth() {
	const current=await getSharedEngineHostState();
	if(!['linked','ready'].includes(current.state))return current;
	const last=Date.parse(String(current.lastHealthAt||''));
	if(Number.isFinite(last)&&Date.now()-last<60_000)return current;
	return saveSharedEngineHostState({state:'ready',lastHealthAt:now(),lastSyncAt:now(),lastError:null},current);
}

export async function assertSharedEngineHostLinked() {
	const state=await getSharedEngineHostState();
	if(!['linked','ready'].includes(state.state)||!state.panelUrl||!state.hostUrl)throw Object.assign(new Error('Shared Engine Host is not linked to OrbitFS Panel.'),{status:503,code:'ENGINE_HOST_NOT_LINKED'});
	return state;
}
