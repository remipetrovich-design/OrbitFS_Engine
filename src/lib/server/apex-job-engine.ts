import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { getWorkspace, requireWorkspacePermission } from '$lib/server/workspaces';
import { readEntryBytes } from '$lib/server/base-compat';
import { analyzeCloudRouting } from '$lib/server/routing-engine-cloud';
import { assertApexSourceAllowed, ensureApexWorkspaceSettings, getApexSource } from '$lib/server/apex-processing-core';
import { buildApexKnowledgePackage, normalizeApexText } from '$lib/server/apex-document-core';
import { APEX_PROCESSOR_ID, type ApexExtractionResult, type ApexImportMode, type ApexJob, type ApexJobStage } from '$lib/server/apex-processing-types';
import type { OrbitUser } from '$lib/server/auth';

const JOB_PREFIX='apex.processing.job.';
const now=()=>new Date().toISOString();
const fail=(message:string,status=400,code='APEX_JOB_ERROR')=>Object.assign(new Error(message),{status,code});
function objectValue(value:unknown):Record<string,any>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};}
const jobKey=(jobId:string)=>`${JOB_PREFIX}${jobId}`;

async function readJobRecord(workspaceId:string,jobId:string):Promise<ApexJob|null>{
	const db=getSupabaseAdmin();const r=await db.from('orbitfs_settings').select('value').eq('scope_type','workspace').eq('scope_id',workspaceId).eq('key',jobKey(jobId)).maybeSingle();if(r.error)throw r.error;
	return r.data?.value&&typeof r.data.value==='object'?r.data.value as ApexJob:null;
}
async function writeJobRecord(workspaceId:string,job:ApexJob){
	const db=getSupabaseAdmin();const r=await db.from('orbitfs_settings').upsert({scope_type:'workspace',scope_id:workspaceId,key:jobKey(job.id),value:job,updated_at:now()},{onConflict:'scope_type,scope_id,key'});if(r.error)throw r.error;return job;
}
async function mutateJob(workspaceId:string,jobId:string,patch:Partial<ApexJob>){
	const job=await readJobRecord(workspaceId,jobId);if(!job)throw fail('APEX processing job not found',404,'APEX_JOB_NOT_FOUND');Object.assign(job,patch,{updatedAt:now()});await writeJobRecord(workspaceId,job);return structuredClone(job);
}

export async function listApexJobs(user:OrbitUser,workspaceId:string){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_view');const db=getSupabaseAdmin();
	const r=await db.from('orbitfs_settings').select('value,updated_at').eq('scope_type','workspace').eq('scope_id',workspaceId).like('key',`${JOB_PREFIX}%`).order('updated_at',{ascending:false}).limit(500);if(r.error)throw r.error;
	return (r.data||[]).map((row:any)=>row.value).filter((value:any)=>value&&typeof value==='object') as ApexJob[];
}

export async function getApexJob(user:OrbitUser,workspaceId:string,jobId:string){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_view');const job=await readJobRecord(workspaceId,jobId);if(!job)throw fail('APEX processing job not found',404,'APEX_JOB_NOT_FOUND');return job;
}

export async function createApexJob(user:OrbitUser,workspaceId:string,input:any={}):Promise<ApexJob>{
	const sourceId=String(input.sourceId||input.source_id||'').trim();if(!sourceId)throw fail('APEX source asset id is required',400,'APEX_SOURCE_REQUIRED');
	const {settings,source}=await assertApexSourceAllowed(user,workspaceId,sourceId);const requested=String(input.importMode||settings.importMode||'knowledge');const importMode=(['knowledge','reference','draft'] as string[]).includes(requested)?requested as ApexImportMode:'knowledge';
	const stamp=now();const job:ApexJob={id:`apx_${randomUUID()}`,workspaceId,type:input.type==='reprocess'?'reprocess':input.type==='revision_import'?'revision_import':input.type==='conversion'?'conversion':'knowledge_import',status:'queued',stage:'queued',progress:0,importMode,source,sourceHash:null,result:null,error:null,errorCode:null,attempts:0,createdByUserId:String(user.id),createdBy:String(user.username||user.id),createdAt:stamp,updatedAt:stamp,startedAt:null,completedAt:null,cancelledAt:null};
	await writeJobRecord(workspaceId,job);return job;
}

async function sourceBytes(workspaceId:string,sourceId:string){
	const db=getSupabaseAdmin();const r=await db.from('orbitfs_files').select('*').eq('workspace_id',workspaceId).eq('id',sourceId).is('deleted_at',null).maybeSingle();if(r.error)throw r.error;if(!r.data||r.data.kind!=='file')throw fail('APEX source asset was not found',404,'APEX_SOURCE_NOT_FOUND');return readEntryBytes(r.data);
}

function routingContent(extraction:ApexExtractionResult,normalize=true){
	const clean=(value:string)=>normalize?normalizeApexText(value):String(value||'').replace(/\r\n?/g,'\n').trim();
	if((extraction.pages||[]).length)return (extraction.pages||[]).map((page)=>clean(page.text||'')).filter(Boolean).join('\n\n');
	return clean(String(extraction.markdown||extraction.rawText||''));
}

export async function runApexCorePipeline(user:OrbitUser,workspaceId:string,jobId:string,extractionInput:Partial<ApexExtractionResult>){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_scan');const current=await getApexJob(user,workspaceId,jobId);
	if(['completed','cancelled'].includes(current.status))throw fail(`APEX job cannot run from ${current.status}`,409,'APEX_JOB_STATE_INVALID');
	const settings=await ensureApexWorkspaceSettings(workspaceId);const source=await getApexSource(workspaceId,current.source.id);let failureStage:ApexJobStage='extract';
	await mutateJob(workspaceId,jobId,{status:'processing',stage:'extract',progress:20,startedAt:current.startedAt||now(),attempts:Number(current.attempts||0)+1,error:null,errorCode:null,source});
	try{
		const bytes=await sourceBytes(workspaceId,source.id);const extraction:ApexExtractionResult={processor:String(extractionInput.processor||APEX_PROCESSOR_ID),source,title:extractionInput.title||null,rawText:String(extractionInput.rawText||''),markdown:extractionInput.markdown==null?null:String(extractionInput.markdown),pages:Array.isArray(extractionInput.pages)?extractionInput.pages:[],metadata:objectValue(extractionInput.metadata),warnings:Array.isArray(extractionInput.warnings)?extractionInput.warnings.map(String):[]};
		const normalize=settings.normalize!==false;
		const normalizedContent=routingContent(extraction,normalize);if(!normalizedContent)throw fail('The APEX processor returned no extractable document content',422,'APEX_EXTRACTION_EMPTY');
		failureStage='normalize';await mutateJob(workspaceId,jobId,{stage:'normalize',progress:40});
		failureStage='structure';await mutateJob(workspaceId,jobId,{stage:'structure',progress:55});
		failureStage='route';await mutateJob(workspaceId,jobId,{stage:'route',progress:70});
		const routingSettings=objectValue(settings.routing);
		const routing=await analyzeCloudRouting(user,workspaceId,{title:extraction.title||source.name,content:normalizedContent,type:'document',category:(extraction.metadata as any)?.category||'',metadata:{projectId:(extraction.metadata as any)?.projectId,projectName:(extraction.metadata as any)?.projectName,sourceAssetId:source.id,sourceFormat:source.extension,processor:extraction.processor}},{
			enabled:true,maxSuggestions:8,minConfidence:.5,
			allowKnowledge:routingSettings.knowledgeArchitecture!==false,
			allowProjects:routingSettings.projects!==false,
			allowProfiles:routingSettings.profiles!==false
		});
		failureStage='fingerprint';await mutateJob(workspaceId,jobId,{stage:'fingerprint',progress:85});
		const result=await buildApexKnowledgePackage({workspaceId,sourceBytes:bytes,extraction,routing,chunkTargetChars:Number(settings.chunkTargetChars),chunkOverlapChars:Number(settings.chunkOverlapChars),normalize});
		const autoCreateNew=settings.autoCreateNew!==false;
		result.metadata={...result.metadata,apex:{...(result.metadata as any)?.apex,processingSettings:{normalize,chunkTargetChars:Number(settings.chunkTargetChars),chunkOverlapChars:Number(settings.chunkOverlapChars),autoCreateNew,routing:{knowledgeArchitecture:routingSettings.knowledgeArchitecture!==false,projects:routingSettings.projects!==false,profiles:routingSettings.profiles!==false}}}};
		const newItemReview=result.duplicate.kind==='new'&&!autoCreateNew;
		if(newItemReview)result.duplicate={...result.duplicate,existingItemName:'New Knowledge item',reason:'APEX processing completed, but Auto-create new Knowledge is disabled. Review is required before Panel creates the Knowledge item.'};
		const needsReview=result.duplicate.kind!=='new'||newItemReview;const finalStatus=needsReview?'awaiting_review':'ready_to_finalize';
		return mutateJob(workspaceId,jobId,{status:finalStatus,stage:needsReview?'duplicate_check':'ready_to_finalize',progress:100,sourceHash:result.source.sourceHash,result,error:null,errorCode:null,completedAt:now()});
	}catch(error:any){await mutateJob(workspaceId,jobId,{status:'failed',stage:failureStage,progress:0,error:String(error?.message||error),errorCode:String(error?.code||'APEX_PROCESSING_FAILED'),completedAt:now()});throw error;}
}

export async function cancelApexJob(user:OrbitUser,workspaceId:string,jobId:string){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_add_to_queue');const job=await getApexJob(user,workspaceId,jobId);if(['completed','failed','cancelled'].includes(job.status))throw fail(`APEX job cannot be cancelled from ${job.status}`,409,'APEX_JOB_STATE_INVALID');return mutateJob(workspaceId,jobId,{status:'cancelled',progress:0,cancelledAt:now(),error:null,errorCode:null});
}

export async function retryApexJob(user:OrbitUser,workspaceId:string,jobId:string){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_scan');const job=await getApexJob(user,workspaceId,jobId);if(!['failed','cancelled'].includes(job.status))throw fail('Only failed or cancelled APEX jobs can be retried',409,'APEX_JOB_STATE_INVALID');return mutateJob(workspaceId,jobId,{status:'queued',stage:'queued',progress:0,error:null,errorCode:null,cancelledAt:null,completedAt:null});
}

export async function markApexJobFinalized(user:OrbitUser,workspaceId:string,jobId:string,input:any={}){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_review_queue');const job=await getApexJob(user,workspaceId,jobId);if(!['ready_to_finalize','awaiting_review'].includes(job.status))throw fail('APEX job is not ready for Panel finalization',409,'APEX_JOB_STATE_INVALID');
	const result=job.result?{...job.result,metadata:{...job.result.metadata,panelKnowledgeItemId:input.knowledgeItemId||null,panelFinalizedAt:now()}}:job.result;return mutateJob(workspaceId,jobId,{status:'completed',stage:'complete',progress:100,result,completedAt:now()});
}