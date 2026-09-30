import { getSupabaseAdmin } from '$lib/server/supabase';
import type { OrbitUser } from '$lib/server/auth';
import {
  createStudioDocument, getStudioDocument, listStudioDocuments, restoreStudioRevision,
  setStudioLifecycle, studioProfiles, studioRevisions, studioSchema, studioWorkspace,
  updateStudioDocument
} from '$lib/server/studio-cloud';
import { analyzeCloudRouting } from '$lib/server/routing-engine-cloud';
import { createLibraryChangeRequest, listLibraryChangeRequests } from '$lib/server/library';

const now=()=>new Date().toISOString();
const clean=(v:any,max=255)=>String(v??'').trim().slice(0,max);
const fail=(m:string,s=400,c='STUDIO_MCP_ERROR')=>Object.assign(new Error(m),{status:s,code:c});
const DEFAULT_VENT={folder:'Vents',organization:'month',behaviour:'pure',customInstructions:'',titleMode:'auto',includeDateTime:true,sectionHeadings:false,retainRaw:true,summary:'none',tags:'off'};
const safe=(v:any)=>String(v||'').trim().replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100)||'unknown';

export async function studioVentProfile(workspaceId:string,identity:any){
  const db=getSupabaseAdmin();
  const row=await db.from('studio_settings').select('settings_json').eq('workspace_id',workspaceId).maybeSingle();
  if(row.error) throw row.error;
  const config={...DEFAULT_VENT,...(row.data?.settings_json?.ventMode||{})};
  const date=new Date();
  const label=new Intl.DateTimeFormat('en-AU',{day:'numeric',month:'long',year:'numeric',timeZone:'Australia/Sydney'}).format(date);
  const month=new Intl.DateTimeFormat('en-AU',{month:'long',year:'numeric',timeZone:'Australia/Sydney'}).format(date);
  const user=`${safe(identity.username||'user')}_${safe(identity.userId).slice(0,12)}`;
  const saveLocation=[clean(config.folder)||'Vents',user,config.organization==='month'?month:''].filter(Boolean).join('/');  const formatTitle=(title:string)=>config.includeDateTime?`${label} - ${clean(title||'Untitled',180).replace(/^\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+-\s+/,'')}`:clean(title||'Untitled',180);
  const behaviourInstructions=[
    'Studio Vent Mode is ACTIVE.',
    "Treat the user's writing as a private Studio vent entry.",
    "Preserve the user's wording, profanity, tone, sequence and first-person perspective.",
    'Do not sanitize, polish, moralize, therapize or reframe unless the user explicitly asks.',
    'Studio owns the working entry and revision history; do not create duplicate sidecar vent files.',
    'Do not submit or publish the vent to Library unless the user explicitly requests it.',
    'Do not change Normal/Vent mode automatically.',
    'Platform safety requirements still apply.',
    clean(config.customInstructions,2000)
  ].filter(Boolean).join('\n');
  return {config,saveLocation,behaviourInstructions,formatTitle};
}

export async function buildStudioUiState(identity:any,workspaceId:string){
  const params=new URLSearchParams({limit:'40'});
  const [records,sessions,profiles,vent]=await Promise.all([
    listStudioDocuments(identity.user,workspaceId,params), listStudioSessions(identity,workspaceId),
    studioProfiles(identity.user,workspaceId), studioVentProfile(workspaceId,identity)
  ]);
  return {workspaceId,schema:studioSchema(),status:{mode:'serverless',state:'ready'},records:records.items||[],sessions:sessions.items||[],profiles:profiles.items||[],studioMode:identity.studioModes?.[workspaceId]==='vent'?'vent':'normal',ventConfig:vent.config,ventSaveLocation:vent.saveLocation,initialView:'home'};
}

export function setStudioModeCloud(identity:any,workspaceId:string,mode:'normal'|'vent'){
  identity.studioModes={...(identity.studioModes||{}),[workspaceId]:mode}; return mode;
}export async function listStudioSessions(identity:any,workspaceId:string,status?:string){
  await studioWorkspace(identity.user,workspaceId,'studio_view');
  let q=getSupabaseAdmin().from('studio_sessions').select('*').eq('workspace_id',workspaceId).eq('owner_user_id',identity.userId).order('updated_at',{ascending:false}).limit(100);
  if(status)q=q.eq('status',status);const r=await q;if(r.error)throw r.error;return {items:r.data||[]};
}
export async function studioSessionCloud(identity:any,workspaceId:string,input:any){
  const db=getSupabaseAdmin(),action=String(input.action||'list');
  if(action==='list')return listStudioSessions(identity,workspaceId);
  await studioWorkspace(identity.user,workspaceId,action==='finalize'?'studio_create':'studio_edit');
  if(action==='start'){
    const r=await db.from('studio_sessions').insert({workspace_id:workspaceId,session_type:clean(input.type)||'standard',title:clean(input.title,180)||'Journal session',status:'active',draft_content:String(input.content||''),owner_user_id:identity.userId,created_by_user_id:identity.userId,created_by:identity.username,settings_json:{}}).select('*').single();
    if(r.error)throw r.error;return {item:r.data};
  }
  const id=clean(input.sessionId);if(!id)throw fail('sessionId is required');
  const current=await db.from('studio_sessions').select('*').eq('id',id).eq('workspace_id',workspaceId).eq('owner_user_id',identity.userId).maybeSingle();
  if(current.error)throw current.error;if(!current.data)throw fail('Studio session not found',404,'STUDIO_SESSION_NOT_FOUND');
  if(action==='append'){
    const text=`${current.data.draft_content||''}${current.data.draft_content?'\n\n':''}${String(input.content||input.text||'')}`;
    const r=await db.from('studio_sessions').update({draft_content:text,updated_at:now()}).eq('id',id).select('*').single();if(r.error)throw r.error;return {item:r.data};
  }
  if(action==='discard'){
    const r=await db.from('studio_sessions').update({status:'discarded',updated_at:now()}).eq('id',id).select('*').single();if(r.error)throw r.error;return {item:r.data};
  }  if(action==='finalize'){
    const created=await createStudioDocument(identity.user,workspaceId,{kind:'journal',type:clean(input.type)||current.data.session_type||'standard',title:clean(input.title,180)||current.data.title,content:current.data.draft_content||'',entryDate:clean(input.entryDate)||null});
    if(input.final!==false)await setStudioLifecycle(identity.user,workspaceId,created.item.id,'finalize');
    const r=await db.from('studio_sessions').update({status:'finalized',document_id:created.item.id,finalized_at:now(),updated_at:now()}).eq('id',id).select('*').single();if(r.error)throw r.error;
    return {item:r.data,record:(await getStudioDocument(identity.user,workspaceId,created.item.id)).item};
  }
  throw fail('Unknown Studio session action',400,'STUDIO_SESSION_ACTION_UNKNOWN');
}

export async function appendStudioCloud(identity:any,workspaceId:string,input:any){
  if(input.sessionId)return studioSessionCloud(identity,workspaceId,{action:'append',sessionId:input.sessionId,content:input.text});
  let recordId=clean(input.recordId);
  if(!recordId){const active=(await listStudioSessions(identity,workspaceId,'active')).items;if(active.length!==1)throw fail(active.length?'Multiple active Studio sessions exist; choose one.':'No active Studio session exists.',409,'STUDIO_SESSION_AMBIGUOUS');return studioSessionCloud(identity,workspaceId,{action:'append',sessionId:active[0].id,content:input.text});}
  const current=(await getStudioDocument(identity.user,workspaceId,recordId)).item;
  const content=`${current.content_text||''}${current.content_text?'\n\n':''}${String(input.text||'')}`;
  return updateStudioDocument(identity.user,workspaceId,recordId,{content,changeNote:input.changeNote||'Appended through ChatGPT'});
}

export async function listStudioLinks(identity:any,workspaceId:string,recordId:string){
  await getStudioDocument(identity.user,workspaceId,recordId);
  const r=await getSupabaseAdmin().from('studio_links').select('*').eq('workspace_id',workspaceId).eq('document_id',recordId).order('created_at');
  if(r.error)throw r.error;return {items:r.data||[]};
}export async function manageStudioLink(identity:any,workspaceId:string,input:any){
  const db=getSupabaseAdmin();
  if(input.action==='remove'){
    const id=clean(input.linkId);if(!id)throw fail('linkId is required');
    const existing=await db.from('studio_links').select('*').eq('id',id).eq('workspace_id',workspaceId).maybeSingle();if(existing.error)throw existing.error;if(!existing.data)throw fail('Studio link not found',404);
    await getStudioDocument(identity.user,workspaceId,existing.data.document_id);const r=await db.from('studio_links').delete().eq('id',id);if(r.error)throw r.error;return {removed:true,id};
  }
  const recordId=clean(input.recordId),targetId=clean(input.targetId);if(!recordId||!targetId)throw fail('recordId and targetId are required');
  await getStudioDocument(identity.user,workspaceId,recordId);await studioWorkspace(identity.user,workspaceId,'studio_manage_links');
  const r=await db.from('studio_links').insert({workspace_id:workspaceId,document_id:recordId,target_type:clean(input.targetType)||'document',target_id:targetId,relation:clean(input.relation)||'related',metadata_json:input.metadata||{},created_by_user_id:identity.userId,created_by:identity.username}).select('*').single();
  if(r.error)throw r.error;return {item:r.data};
}

export async function createDocumentFromRecord(identity:any,workspaceId:string,input:any){
  const source=(await getStudioDocument(identity.user,workspaceId,input.sourceRecordId)).item;
  const created=await createStudioDocument(identity.user,workspaceId,{kind:'document',type:input.type||'general',title:input.title||`${source.title} - Document`,content:input.content!==undefined?input.content:(source.content_text||''),summary:input.summary!==undefined?input.summary:source.summary,tags:input.tags||source.metadata_json?.tags||[],profileIds:input.profileIds||source.profile_ids||[],metadata:{...(source.metadata_json||{}),sourceRecordId:source.id,sourceRecordKind:source.kind}});
  const link=await manageStudioLink(identity,workspaceId,{action:'add',recordId:created.item.id,targetType:'document',targetId:source.id,relation:'derived-from',metadata:{createdThrough:'mcp'}}).catch(()=>null);
  return {record:created.item,sourceRecord:source,link};
}

export async function analyseStudioRouting(identity:any,workspaceId:string,recordId:string){
  const doc=(await getStudioDocument(identity.user,workspaceId,recordId)).item,meta=doc.metadata_json||{};
  return analyzeCloudRouting(identity.user,workspaceId,{id:doc.id,title:doc.title,content:doc.content_text,type:doc.subtype,date:doc.entry_date,profileIds:doc.profile_ids||[],profileTargetId:meta.profileTargetId,profileSectionId:meta.profileSectionId,category:meta.category,metadata:meta},{});
}function defaultOperation(doc:any){
  const meta=doc.metadata_json||{},roleMap:any={incident:'incident_log',timeline:'timeline',evidence:'evidence_target',reference:'reference_target'};
  return String(doc.subtype)==='profile-record'
    ? {type:'profile_record_add',profileId:String(meta.profileTargetId||''),sectionId:String(meta.profileSectionId||'records'),title:doc.title,content:doc.content_text,date:doc.entry_date,category:String(meta.category||'general')}
    : {type:'append_to_role',role:roleMap[String(doc.subtype)]||'general_record_target',title:doc.title,content:doc.content_text,date:doc.entry_date,category:String(meta.category||'general')};
}
function suggestionOperation(doc:any,s:any){
  const meta=doc.metadata_json||{};
  if(s.kind==='profile_record_add')return {type:'profile_record_add',profileId:String(s.profileId||meta.profileTargetId||''),sectionId:String(s.sectionId||meta.profileSectionId||'records'),title:doc.title,content:doc.content_text,date:doc.entry_date,category:String(meta.category||'general')};
  if(s.kind==='library_item_update'&&s.itemId)return {type:'append_to_item',itemId:String(s.itemId),title:doc.title,content:doc.content_text,date:doc.entry_date,category:String(meta.category||'general')};
  return {type:'append_to_role',role:String(s.role||'general_record_target'),itemId:s.itemId?String(s.itemId):undefined,title:doc.title,content:doc.content_text,date:doc.entry_date,category:String(meta.category||'general')};
}
export async function submitStudioApproval(identity:any,workspaceId:string,recordId:string,input:any={}){
  const doc=(await getStudioDocument(identity.user,workspaceId,recordId)).item;
  let operations:any[]=[defaultOperation(doc)];
  if(input.useRoutingSuggestions===true){const analysis=await analyseStudioRouting(identity,workspaceId,recordId),indexes=Array.isArray(input.routingSuggestionIndexes)?input.routingSuggestionIndexes:analysis.suggestions.map((_:any,i:number)=>i);operations=indexes.map((i:number)=>analysis.suggestions[i]).filter(Boolean).map((s:any)=>suggestionOperation(doc,s));if(!operations.length)operations=[defaultOperation(doc)];}
  const request=await createLibraryChangeRequest(identity.user,workspaceId,{source:{system:'studio',entryId:doc.id,revision:doc.current_revision,title:doc.title},sourceSnapshot:{entryId:doc.id,revision:doc.current_revision,status:doc.status},summary:clean(input.summary,500)||`Publish Studio entry: ${doc.title}`,reason:clean(input.reason,1000)||undefined,operations});
  return {request};
}
export async function studioApprovals(identity:any,workspaceId:string,recordId:string){return listLibraryChangeRequests(identity.user,workspaceId,{sourceSystem:'studio',sourceEntryId:recordId});}
