import { createHash } from 'node:crypto';
import type { OrbitUser } from '$lib/server/auth';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { visibleWorkspaces, workspaceMembers, isSystemAdmin } from '$lib/server/workspaces';
import { profileCatalog } from '$lib/server/workspace-profiles.js';

const now=()=>new Date().toISOString();
const clean=(v:any)=>String(v??'').trim();
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const fail=(message:string,status=400,code='STUDIO_ERROR')=>Object.assign(new Error(message),{status,code});

export async function studioWorkspace(user:OrbitUser,workspaceId:string,capability='studio_view'){
  const workspace=(await visibleWorkspaces(user)).find((w:any)=>String(w.id)===String(workspaceId));
  if(!workspace) throw fail('Studio workspace is unavailable',404,'WORKSPACE_NOT_FOUND');
  if(capability && workspace.management_permissions?.[capability]!==true) throw fail('Studio permission denied',403,'STUDIO_PERMISSION_DENIED');
  return workspace;
}


export const STUDIO_SETTINGS_DEFAULTS:any={
  provisionExisting:true,
  maxJournalBytes:2097152,
  maxDocumentBytes:5242880,
  maxSessionBytes:2097152,
  maxImportBytes:20971520,
  maxExportBytes:52428800,
  routingEnabled:true,
  routingAutoAnalyzeCreate:true,
  routingAutoAnalyzeUpdate:true,
  routingMinConfidence:.55,
  routingProfileConfidence:.70,
  routingIncidentConfidence:.62,
  routingTimelineConfidence:.55,
  routingMaxSuggestions:8,
  routingMaxCharacters:50000,
  semanticProvider:null,
  semanticProviderStatus:'not_configured',
  matcherType:'deterministic',
  analysisPolicy:{
    candidateFloor:.35,reviewThreshold:.52,conflictThreshold:.58,mergeThreshold:.78,updateThreshold:.72,addConfidence:.64,
    detectConflicts:true,detectMerges:true,useStructureSignal:true,
    weights:{content:1,title:.65,date:.35,type:.4,entities:.55,structure:.45},
    maxCandidatesPerRecord:8,
    limits:{maxSourcesPerRun:250,maxRecordsPerRun:5000,queueDepthLimit:20,stuckTaskMinutes:15},
    providers:{enabledByDefault:true,deterministic:true,knowledgeArchitecture:true,maxRecords:500,maxSources:1000}
  }
};
function mergeStudioSettings(value:any={}){
  const v=value&&typeof value==='object'?value:{};
  const incoming=v.analysisPolicy||{}; const providerInput=incoming.providers||{}; return {...STUDIO_SETTINGS_DEFAULTS,...v,analysisPolicy:{...STUDIO_SETTINGS_DEFAULTS.analysisPolicy,...incoming,weights:{...STUDIO_SETTINGS_DEFAULTS.analysisPolicy.weights,...(incoming.weights||{})},limits:{...STUDIO_SETTINGS_DEFAULTS.analysisPolicy.limits,...(incoming.limits||{})},providers:{enabledByDefault:providerInput.enabledByDefault!==false,deterministic:true,knowledgeArchitecture:true,maxRecords:Number(providerInput.maxRecords||500),maxSources:Number(providerInput.maxSources||1000)}}};
}
export async function getStudioRuntimeSettings(){
  const db=getSupabaseAdmin();
  const r=await db.from('studio_settings').select('settings_json,updated_at').eq('workspace_id','__global__').maybeSingle();
  if(r.error) throw r.error;
  return mergeStudioSettings(r.data?.settings_json||{});
}
export async function getStudioAdminSettings(user:OrbitUser){
  if(!isSystemAdmin(user)) throw fail('System Owner or Admin required',403);
  const db=getSupabaseAdmin();
  const r=await db.from('studio_settings').select('settings_json,updated_at').eq('workspace_id','__global__').maybeSingle();
  if(r.error) throw r.error;
  const settings=mergeStudioSettings(r.data?.settings_json||{});
  const docs=await db.from('studio_documents').select('content_text');
  if(docs.error) throw docs.error;
  const totalBytes=(docs.data||[]).reduce((n:any,row:any)=>n+Buffer.byteLength(String(row.content_text||''),'utf8'),0);
  return {settings,storageUsage:{totalBytes,bytes:totalBytes,provider:'supabase',filesystem:false},processing:{state:'ready',database:true,residentProcess:false,mode:'serverless',requestDriven:true},routing:{engine:'orbitfs-base-routing-v2-cloud',provider:'deterministic',semanticProvider:null,semanticProviderStatus:'not_configured'}};
}
export async function updateStudioAdminSettings(user:OrbitUser,input:any={}){
  if(!isSystemAdmin(user)) throw fail('System Owner or Admin required',403);
  const db=getSupabaseAdmin();
  const current=(await getStudioAdminSettings(user)).settings;
  const clamp=(value:any,min:number,max:number,fallback:number)=>Math.max(min,Math.min(max,Number(value??fallback)));
  const next=mergeStudioSettings({
    ...current,
    provisionExisting:input.provisionExisting===undefined?current.provisionExisting:input.provisionExisting===true,
    maxJournalBytes:clamp(input.maxJournalBytes,65536,20971520,current.maxJournalBytes),
    maxDocumentBytes:clamp(input.maxDocumentBytes,65536,20971520,current.maxDocumentBytes),
    maxSessionBytes:clamp(input.maxSessionBytes,65536,10485760,current.maxSessionBytes),
    maxImportBytes:clamp(input.maxImportBytes,1048576,104857600,current.maxImportBytes),
    maxExportBytes:clamp(input.maxExportBytes,1048576,104857600,current.maxExportBytes),
    routingEnabled:input.routingEnabled===undefined?current.routingEnabled:input.routingEnabled!==false,
    routingAutoAnalyzeCreate:input.routingAutoAnalyzeCreate===undefined?current.routingAutoAnalyzeCreate:input.routingAutoAnalyzeCreate!==false,
    routingAutoAnalyzeUpdate:input.routingAutoAnalyzeUpdate===undefined?current.routingAutoAnalyzeUpdate:input.routingAutoAnalyzeUpdate!==false,
    routingMinConfidence:clamp(input.routingMinConfidence,0,1,current.routingMinConfidence),
    routingProfileConfidence:clamp(input.routingProfileConfidence,0,1,current.routingProfileConfidence),
    routingIncidentConfidence:clamp(input.routingIncidentConfidence,0,1,current.routingIncidentConfidence),
    routingTimelineConfidence:clamp(input.routingTimelineConfidence,0,1,current.routingTimelineConfidence),
    routingMaxSuggestions:Math.round(clamp(input.routingMaxSuggestions,1,20,current.routingMaxSuggestions)),
    routingMaxCharacters:Math.round(clamp(input.routingMaxCharacters,1000,200000,current.routingMaxCharacters)),
    analysisPolicy:input.analysisPolicy&&typeof input.analysisPolicy==='object'?input.analysisPolicy:current.analysisPolicy
  });
  const r=await db.from('studio_settings').upsert({workspace_id:'__global__',settings_json:next,updated_by:user.username,updated_at:now()},{onConflict:'workspace_id'}).select('settings_json').single();
  if(r.error) throw r.error;
  return {settings:mergeStudioSettings(r.data.settings_json),storageUsage:(await getStudioAdminSettings(user)).storageUsage,compatibility:{sourceFormat:'md',panel:true,mcp:false,apex:false,filesystem:false}};
}
export function studioEngineState(){
  return {state:'ready',database:true,residentProcess:false,mode:'serverless',requestDriven:true,deprecatedEngineConcept:true,detail:'Studio processing is request-driven inside the Panel; no dedicated Studio engine is required.'};
}

export function studioSchema(){return {
  entryTypes:['general','note','letter','document','profile-record','statement','report','evidence','incident','timeline','reference','research'],
  journalTypes:['standard','daily','personal','incident','mental-health','court','legal','work','project','research','meeting'],
  documentTypes:['general','note','statement','letter','report','evidence','incident','timeline','profile-record','reference','research','document'],
  categories:['general','personal','mental-health','legal','court','work','project','research','evidence','reference'],
  metadataFields:['tags','profileIds','profileTargetId','profileSectionId','category','purpose','audience','source','language','chatgptThreadId','mcpSessionId'],
  compactListing:true,revisions:true,sessions:true,links:true,templates:true
};}

function compactDocument(row:any){return {...row,metadata_json:row.metadata_json||{},profile_ids:row.profile_ids||[],access:row.access};}
async function documentAccess(user:OrbitUser,workspaceId:string,id:string){
  const workspace=await studioWorkspace(user,workspaceId,'studio_view');
  const db=getSupabaseAdmin();
  const result=await db.from('studio_documents').select('*').eq('workspace_id',workspaceId).eq('id',id).maybeSingle();
  if(result.error) throw result.error;
  if(!result.data) throw fail('Studio entry not found',404,'STUDIO_NOT_FOUND');
  const doc:any=result.data;
  const owner=String(doc.owner_user_id)===String(user.id);
  const share=await db.from('studio_shares').select('permission').eq('document_id',id).eq('user_id',user.id).maybeSingle();
  if(share.error) throw share.error;
  const manager=isSystemAdmin(user)||workspace.permission==='owner';
  const canRead=manager||owner||Boolean(share.data);
  if(!canRead) throw fail('Studio entry is private',403,'STUDIO_PRIVATE');
  const canEdit=manager||owner||share.data?.permission==='write';
  return {workspace,doc:{...doc,access:{canRead,canEdit,canManageShares:manager||owner}}};
}

export async function listStudioDocuments(user:OrbitUser,workspaceId:string,params:URLSearchParams){
  const workspace=await studioWorkspace(user,workspaceId,'studio_view');
  const db=getSupabaseAdmin();
  const manager=isSystemAdmin(user)||workspace.permission==='owner';
  const scope=clean(params.get('scope'))||'visible';
  const ownerFilter=clean(params.get('ownerUserId'));
  let query=db.from('studio_documents').select('*').eq('workspace_id',workspaceId).order('updated_at',{ascending:false}).limit(Math.min(250,Math.max(1,Number(params.get('limit')||100))));
  if(manager&&ownerFilter) query=query.eq('owner_user_id',ownerFilter);
  const result=await query;if(result.error) throw result.error;
  const shares=await db.from('studio_shares').select('document_id,permission').eq('workspace_id',workspaceId).eq('user_id',user.id);
  if(shares.error) throw shares.error;
  const shareMap=new Map((shares.data||[]).map((x:any)=>[String(x.document_id),x.permission]));
  const items=(result.data||[]).filter((doc:any)=>{
    if(manager) return scope==='mine'?String(doc.owner_user_id)===String(user.id):scope==='shared'?shareMap.has(String(doc.id)):true;
    const mine=String(doc.owner_user_id)===String(user.id), shared=shareMap.has(String(doc.id));
    if(scope==='mine') return mine;if(scope==='shared') return shared;return mine||shared;
  }).map((doc:any)=>compactDocument(doc));
  return {items,canSeeAll:manager};
}

export async function getStudioDocument(user:OrbitUser,workspaceId:string,id:string){
  const {doc}=await documentAccess(user,workspaceId,id);return {item:compactDocument(doc)};
}

export async function createStudioDocument(user:OrbitUser,workspaceId:string,input:any){
  await studioWorkspace(user,workspaceId,'studio_create');const db=getSupabaseAdmin();
  const title=clean(input.title)||'Entry',kind=['journal','document','generated'].includes(clean(input.kind))?clean(input.kind):'document';
  const ownerUserId=clean(input.ownerUserId)||user.id, subtype=clean(input.subtype||input.type)||'general';
  const row:any={workspace_id:workspaceId,kind,subtype,title,status:'draft',content_format:'md',content_text:String(input.content||''),summary:clean(input.summary)||null,
    entry_date:clean(input.entryDate)||null,current_revision:1,owner_user_id:ownerUserId,created_by_user_id:user.id,created_by:user.username,visibility:'private',
    profile_ids:Array.isArray(input.profileIds)?input.profileIds.map(String):[],save_location:'',metadata_json:{category:clean(input.category)||'general',profileTargetId:clean(input.profileTargetId),profileSectionId:clean(input.profileSectionId)||'records',tags:Array.isArray(input.tags)?input.tags:[]}};
  const saved=await db.from('studio_documents').insert(row).select('*').single();if(saved.error) throw saved.error;
  const rev=await db.from('studio_revisions').insert({document_id:saved.data.id,revision_no:1,content_text:row.content_text,content_hash:hash(row.content_text),change_note:'Created',created_by:user.username});if(rev.error) throw rev.error;
  return {item:compactDocument({...saved.data,access:{canRead:true,canEdit:true,canManageShares:true}})};
}
export async function updateStudioDocument(user:OrbitUser,workspaceId:string,id:string,input:any){
  const {workspace,doc}=await documentAccess(user,workspaceId,id);if(!doc.access?.canEdit||workspace.management_permissions?.studio_edit!==true) throw fail('Studio edit permission denied',403);
  const db=getSupabaseAdmin(),nextContent=input.content===undefined?String(doc.content_text||''):String(input.content||'');
  const nextRevision=Number(doc.current_revision||1)+1, metadata={...(doc.metadata_json||{})};
  if(input.category!==undefined)metadata.category=clean(input.category)||'general';if(input.profileTargetId!==undefined)metadata.profileTargetId=clean(input.profileTargetId);if(input.profileSectionId!==undefined)metadata.profileSectionId=clean(input.profileSectionId)||'records';if(input.tags!==undefined)metadata.tags=Array.isArray(input.tags)?input.tags:[];
  const patch:any={title:clean(input.title)||doc.title,subtype:clean(input.subtype||input.type)||doc.subtype,content_text:nextContent,summary:input.summary===undefined?doc.summary:clean(input.summary)||null,entry_date:input.entryDate===undefined?doc.entry_date:(clean(input.entryDate)||null),profile_ids:Array.isArray(input.profileIds)?input.profileIds.map(String):doc.profile_ids,save_location:'',metadata_json:metadata,current_revision:nextRevision,updated_at:now()};
  const saved=await db.from('studio_documents').update(patch).eq('id',id).eq('workspace_id',workspaceId).select('*').single();if(saved.error)throw saved.error;
  const rev=await db.from('studio_revisions').insert({document_id:id,revision_no:nextRevision,content_text:nextContent,content_hash:hash(nextContent),change_note:clean(input.changeNote)||'Edited',created_by:user.username});if(rev.error)throw rev.error;
  return {item:compactDocument({...saved.data,access:doc.access})};
}

export async function setStudioLifecycle(user:OrbitUser,workspaceId:string,id:string,action:'finalize'|'archive'|'draft'){
  const required=action==='finalize'?'studio_finalize':action==='archive'?'studio_archive':'studio_edit';const {doc}=await documentAccess(user,workspaceId,id);await studioWorkspace(user,workspaceId,required);if(!doc.access?.canEdit&&action==='draft')throw fail('Studio edit permission denied',403);
  const patch:any={status:action==='finalize'?'final':action==='archive'?'archived':'draft',updated_at:now()};patch.finalized_at=action==='finalize'?now():action==='draft'?null:doc.finalized_at;patch.archived_at=action==='archive'?now():action==='draft'?null:doc.archived_at;
  const saved=await getSupabaseAdmin().from('studio_documents').update(patch).eq('id',id).eq('workspace_id',workspaceId).select('*').single();if(saved.error)throw saved.error;return {item:compactDocument({...saved.data,access:doc.access})};
}

export async function studioRevisions(user:OrbitUser,workspaceId:string,id:string){await documentAccess(user,workspaceId,id);const r=await getSupabaseAdmin().from('studio_revisions').select('*').eq('document_id',id).order('revision_no',{ascending:false});if(r.error)throw r.error;return {items:r.data||[]};}
export async function restoreStudioRevision(user:OrbitUser,workspaceId:string,id:string,revisionNo:number){
  const {workspace,doc}=await documentAccess(user,workspaceId,id);if(!doc.access?.canEdit||workspace.management_permissions?.studio_edit!==true)throw fail('Studio edit permission denied',403);
  const db=getSupabaseAdmin(),rev=await db.from('studio_revisions').select('*').eq('document_id',id).eq('revision_no',revisionNo).maybeSingle();if(rev.error)throw rev.error;if(!rev.data)throw fail('Revision not found',404);
  return updateStudioDocument(user,workspaceId,id,{content:rev.data.content_text,changeNote:`Restored revision ${revisionNo}`});
}

export async function studioShares(user:OrbitUser,workspaceId:string,id:string){await documentAccess(user,workspaceId,id);const r=await getSupabaseAdmin().from('studio_shares').select('*').eq('document_id',id).order('created_at');if(r.error)throw r.error;return {items:r.data||[]};}
export async function saveStudioShare(user:OrbitUser,workspaceId:string,id:string,input:any){
  const {workspace,doc}=await documentAccess(user,workspaceId,id);if(!doc.access?.canManageShares||workspace.management_permissions?.studio_manage_links!==true)throw fail('Studio share permission denied',403);
  const userId=clean(input.userId),permission=clean(input.permission)==='write'?'write':'read';if(!userId)throw fail('A user is required');
  const r=await getSupabaseAdmin().from('studio_shares').upsert({document_id:id,workspace_id:workspaceId,user_id:userId,permission,shared_by_user_id:user.id},{onConflict:'document_id,user_id'});if(r.error)throw r.error;
  await getSupabaseAdmin().from('studio_documents').update({visibility:'shared',updated_at:now()}).eq('id',id);return {ok:true};
}
export async function deleteStudioShare(user:OrbitUser,workspaceId:string,id:string,userId:string){
  const {workspace,doc}=await documentAccess(user,workspaceId,id);if(!doc.access?.canManageShares||workspace.management_permissions?.studio_manage_links!==true)throw fail('Studio share permission denied',403);
  const db=getSupabaseAdmin(),r=await db.from('studio_shares').delete().eq('document_id',id).eq('user_id',userId);if(r.error)throw r.error;const left=await db.from('studio_shares').select('user_id',{count:'exact',head:true}).eq('document_id',id);if(!left.error&&Number(left.count||0)===0)await db.from('studio_documents').update({visibility:'private',updated_at:now()}).eq('id',id);return {ok:true};
}

export async function studioPeople(user:OrbitUser,workspaceId:string){
  const workspace=await studioWorkspace(user,workspaceId,'studio_view'),members=await workspaceMembers(workspaceId),ids=[user.id,...members.map((m:any)=>m.user_id),workspace.owner_id].filter(Boolean);const unique=[...new Set(ids.map(String))];
  const r=unique.length?await getSupabaseAdmin().from('orbitfs_users').select('id,username,role,status').in('id',unique):{data:[],error:null} as any;if(r.error)throw r.error;
  return {items:(r.data||[]).filter((x:any)=>x.status==='active').map((x:any)=>({userId:x.id,username:x.username,role:x.role,current:String(x.id)===String(user.id)})),canSeeAll:isSystemAdmin(user)||workspace.permission==='owner'};
}
export async function studioProfiles(user:OrbitUser,workspaceId:string){
  const workspace=await studioWorkspace(user,workspaceId,'studio_view');
  const catalog=await profileCatalog(workspaceId,workspace.permission||'viewer',user.id,user.role);
  return {items:catalog.profiles||[]};
}
