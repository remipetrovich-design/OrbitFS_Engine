import { getSupabaseAdmin } from '$lib/server/supabase';
import { authorizeEngineHostRequest } from '$lib/server/engine-host-link';
import { assertAddonEngineAccepting } from '$lib/server/addon-engine';
import { getApexExecutionPolicy } from '$lib/server/apex-policy';
import type { OrbitUser } from '$lib/server/auth';

const fail=(message:string,status=403,code='APEX_ENGINE_AUTH_REQUIRED')=>Object.assign(new Error(message),{status,code});

export function assertApexEngineRequest(request:Request,rawBody=''){
	if(!authorizeEngineHostRequest(request,rawBody))throw fail('APEX Engine Host request was not authorized',404,'NOT_FOUND');
}

export async function assertApexEngineAttachedRequest(request:Request,rawBody='',requireSetup=true){
	assertApexEngineRequest(request,rawBody);
	return assertAddonEngineAccepting('apex',{requireSetup});
}

export async function assertApexEngineExecutionRequest(request:Request,rawBody='',requireSetup=true){
	const state=await assertApexEngineAttachedRequest(request,rawBody,requireSetup);
	const policy=await getApexExecutionPolicy();
	if(policy.fullShutdown)throw fail('APEX processing is disabled by the system administrator',423,'APEX_SHUTDOWN');
	return {state,policy};
}

export async function apexActor(userId:unknown):Promise<OrbitUser>{
	const id=String(userId||'').trim();if(!id)throw fail('APEX actor user id is required',400,'APEX_ACTOR_REQUIRED');
	const db=getSupabaseAdmin();const r=await db.from('orbitfs_users').select('*').eq('id',id).maybeSingle();if(r.error)throw r.error;
	if(!r.data||String(r.data.status||'active')!=='active')throw fail('APEX actor is not an active OrbitFS user',403,'APEX_ACTOR_INVALID');return r.data as OrbitUser;
}
