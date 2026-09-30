import { getSupabaseAdmin } from '$lib/server/supabase';
import { readEntryBytes } from '$lib/server/base-compat';
import { assertApexSourceAllowed } from '$lib/server/apex-processing-core';
import { getApexJob, runApexCorePipeline } from '$lib/server/apex-job-engine';
import type { OrbitUser } from '$lib/server/auth';
import type { ApexExtractionResult, ApexSourceDescriptor } from '$lib/server/apex-processing-types';
import { createBuiltinApexProcessors } from '$lib/server/apex-processor-adapters';

export type ApexProcessorContext={workspaceId:string;source:ApexSourceDescriptor;bytes:Buffer;user:OrbitUser};
export type ApexProcessorAdapter={id:string;version:string;extensions:string[];extract:(context:ApexProcessorContext)=>Promise<ApexExtractionResult>};

const adapters=new Map<string,ApexProcessorAdapter>();

export function registerApexProcessor(adapter:ApexProcessorAdapter){
	if(!adapter?.id||!adapter.version||!Array.isArray(adapter.extensions)||typeof adapter.extract!=='function')throw new Error('Invalid APEX processor adapter');
	for(const extension of adapter.extensions.map((x)=>String(x).toLowerCase().replace(/^\./,'')))adapters.set(extension,adapter);
	return adapter;
}

export function apexProcessorFor(extension:string){return adapters.get(String(extension||'').toLowerCase().replace(/^\./,''))||null;}
export function listApexProcessorCapabilities(){
	const seen=new Map<string,ApexProcessorAdapter>();for(const adapter of adapters.values())seen.set(adapter.id,adapter);
	return [...seen.values()].map((adapter)=>({id:adapter.id,version:adapter.version,extensions:[...adapter.extensions],available:true}));
}

for(const adapter of createBuiltinApexProcessors())registerApexProcessor(adapter);

async function readSource(workspaceId:string,sourceId:string){
	const db=getSupabaseAdmin();const r=await db.from('orbitfs_files').select('*').eq('workspace_id',workspaceId).eq('id',sourceId).is('deleted_at',null).maybeSingle();if(r.error)throw r.error;
	if(!r.data||r.data.kind!=='file')throw Object.assign(new Error('APEX source asset was not found'),{status:404,code:'APEX_SOURCE_NOT_FOUND'});
	return readEntryBytes(r.data);
}

export async function processApexJob(user:OrbitUser,workspaceId:string,jobId:string,sourceId:string){
	const job=await getApexJob(user,workspaceId,jobId);
	if(String(job.source.id)!==String(sourceId))throw Object.assign(new Error('APEX job source does not match the requested source asset'),{status:409,code:'APEX_JOB_SOURCE_MISMATCH'});
	const {source}=await assertApexSourceAllowed(user,workspaceId,sourceId);const adapter=apexProcessorFor(source.extension);
	if(!adapter)throw Object.assign(new Error(`APEX extraction adapter for .${source.extension||'unknown'} is not installed yet`),{status:503,code:'APEX_PROCESSOR_UNAVAILABLE'});
	const bytes=await readSource(workspaceId,source.id);const extraction=await adapter.extract({workspaceId,source,bytes,user});
	return runApexCorePipeline(user,workspaceId,jobId,extraction);
}
