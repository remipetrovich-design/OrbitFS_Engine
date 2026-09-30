import { createHash } from 'node:crypto';
import type { OrbitUser } from '$lib/server/auth';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { studioWorkspace,getStudioRuntimeSettings } from '$lib/server/studio-cloud';
import { readLibrary,createLibraryChangeRequest } from '$lib/server/library';
import { profileCatalog,profileKnowledgeProjection } from '$lib/server/workspace-profiles.js';
import { analyzeCloudRouting } from '$lib/server/routing-engine-cloud';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const now=()=>new Date().toISOString();
const clean=(v:any)=>String(v??'').trim();
const fail=(m:string,s=400)=>Object.assign(new Error(m),{status:s});

function findingType(s:any){
  if(s.action==='update_candidate'||s.action==='update')return 'update';
  if(s.kind==='profile_record_add'||s.kind==='knowledge_record_add')return 'add';
  if(s.kind==='library_item_update')return 'update';
  return 'review';
}
function targetSystem(s:any){return s.kind==='profile_record_add'?'profiles':'library';}
function reviewPayload(source:any,s:any){
  return {
    source:{title:source.title,type:source.recordType,date:source.date,content:source.content},
    action:s.action||'review',
    targetSystem:targetSystem(s),
    targetItemId:s.itemId||s.existing?.itemId||s.existing?.id||null,
    targetSectionId:s.sectionId||null,
    target:s.existing||null,
    proposedContent:source.content,
    scores:{confidence:s.confidence,reason:s.reason}
  };
}

async function collectSources(user:OrbitUser,workspaceId:string,input:any,settings:any){
  const scope=clean(input.scope||'workspace')||'workspace';
  const selected=input.selection&&typeof input.selection==='object'?input.selection:{};
  const out:any[]=[];
  if(['workspace','library','selection'].includes(scope)){
    const state=await readLibrary(workspaceId);
    const ids=new Set((selected.itemIds||[]).map(String));
    for(const item of state.items||[]){
      if(scope==='selection'&&!ids.has(String(item.id)))continue;
      if(item.status!=='active'||['archived','deprecated'].includes(String(item.lifecycleState||item.lifecycle)))continue;
      const content=item.source?.provider==='library.native'||item.source?.provider==='memory.knowledge'?String(item.content||''):String(item.indexedContent||'');
      if(!content.trim())continue;
      out.push({sourceKey:`library:${item.id}`,sourceType:'library',provider:item.source?.provider||'library.native',itemId:item.id,title:item.name||'Library item',updatedAt:item.updatedAt||null,recordType:(item.roles||[]).includes('incident_log')?'incident':(item.roles||[]).includes('timeline')?'timeline':'document',content,metadata:{roles:item.roles||[],category:item.category||null}});
    }
  }
  if(['workspace','profiles','selection'].includes(scope)){
    const ws=await studioWorkspace(user,workspaceId,'studio_view');
    const catalog=await profileCatalog(workspaceId,ws.permission||'viewer',user.id,user.role);
    const ids=new Set((selected.profileIds||[]).map(String));
    for(const p of catalog.profiles||[]){
      if(scope==='selection'&&!ids.has(String(p.id)))continue;
      const full=await profileKnowledgeProjection(workspaceId,p.id,ws.permission||'viewer',user.id,user.role);
      const content=(full.profile?.sections||[]).map((s:any)=>`## ${s.title||s.id}\n${s.content||''}`).join('\n\n').trim();
      if(!content)continue;
      out.push({sourceKey:`profile:${p.id}`,sourceType:'profile',provider:'base.profiles',profileId:p.id,title:p.name||'Profile',updatedAt:p.updatedAt||null,recordType:'profile-record',content,metadata:{profileId:p.id,type:p.type||p.classification||null}});
    }
  }
  if(['workspace','studio','selection'].includes(scope)){
    const db=getSupabaseAdmin();const ids=new Set((selected.documentIds||[]).map(String));
    let q=db.from('studio_documents').select('*').eq('workspace_id',workspaceId).neq('status','archived').order('updated_at',{ascending:false}).limit(Math.min(500,Number(settings.analysisPolicy?.limits?.maxSourcesPerRun||250)));
    const r=await q;if(r.error)throw r.error;
    for(const d of r.data||[]){
      if(scope==='selection'&&!ids.has(String(d.id)))continue;
      if(!String(d.content_text||'').trim())continue;
      out.push({sourceKey:`studio:${d.id}`,sourceType:'studio',provider:'studio',sourceRef:d.id,title:d.title,updatedAt:d.updated_at,recordType:d.subtype||'document',date:d.entry_date,content:String(d.content_text||''),metadata:d.metadata_json||{}});
    }
  }
  const max=Math.min(Number(settings.analysisPolicy?.limits?.maxSourcesPerRun||250),Number(settings.analysisMaxItems||250));
  return out.slice(0,Math.max(1,max));
}

export async function listCloudAnalysisRuns(user:OrbitUser,workspaceId:string,limit=50){
  await studioWorkspace(user,workspaceId,'studio_view');const db=getSupabaseAdmin();
  const r=await db.from('studio_analysis_runs').select('*').eq('workspace_id',workspaceId).order('created_at',{ascending:false}).limit(Math.min(200,Math.max(1,limit)));if(r.error)throw r.error;
  return {items:r.data||[],processing:{state:'ready',mode:'serverless',residentProcess:false,operational:true}};
}

export async function startCloudAnalysis(user:OrbitUser,workspaceId:string,input:any={}){
  await studioWorkspace(user,workspaceId,'studio_analyse');const db=getSupabaseAdmin();
  const settings=await getStudioRuntimeSettings();
  const scope=clean(input.scope||'workspace')||'workspace';
  const created=await db.from('studio_analysis_runs').insert({workspace_id:workspaceId,scope_type:scope,scope_json:input.selection||{},status:'running',phase:'inventory',progress:5,created_by_user_id:user.id,created_by:user.username,started_at:now(),provider_json:{base:'deterministic',library:true,profiles:true,studio:true,knowledgeArchitecture:true}}).select('*').single();
  if(created.error)throw created.error;const run=created.data;
  try{
    const sources=await collectSources(user,workspaceId,input,settings);
    let chars=0,records=0,findings=0;
    for(const source of sources){
      const cap=Math.max(1000,Number(settings.analysisMaxCharacters||1500000)-chars);if(cap<=0)break;
      const content=String(source.content||'').slice(0,cap);chars+=content.length;
      const sr=await db.from('studio_analysis_sources').insert({run_id:run.id,workspace_id:workspaceId,source_key:source.sourceKey,source_type:source.sourceType,provider:source.provider,source_ref:source.sourceRef||null,item_id:source.itemId||null,profile_id:source.profileId||null,title:source.title,source_hash:hash(content),source_updated_at:source.updatedAt||null,metadata_json:source.metadata||{},status:'ready'}).select('*').single();if(sr.error)throw sr.error;
      const rr=await db.from('studio_analysis_records').insert({run_id:run.id,source_id:sr.data.id,record_key:`${source.sourceKey}:0`,record_type:source.recordType||'general',title:source.title,body:content,date_start:source.date||null,content_hash:hash(content),metadata_json:source.metadata||{}}).select('*').single();if(rr.error)throw rr.error;records++;
      const analysis=await analyzeCloudRouting(user,workspaceId,{id:source.sourceRef||source.itemId||source.profileId,title:source.title,content,date:source.date,type:source.recordType,profileTargetId:source.profileId,metadata:source.metadata||{}},{minConfidence:settings.routingMinConfidence,profileConfidence:settings.routingProfileConfidence,incidentConfidence:settings.routingIncidentConfidence,timelineConfidence:settings.routingTimelineConfidence,maxSuggestions:settings.routingMaxSuggestions,maxCharacters:settings.routingMaxCharacters});
      const suggestions=analysis.suggestions||[];
      if(!suggestions.length){
        const ins=await db.from('studio_analysis_findings').insert({run_id:run.id,record_id:rr.data.id,finding_type:'no_change',confidence:1,explanation:'No actionable routing or knowledge change was detected.',score_json:{processor:analysis.processor},status:'candidate'});if(ins.error)throw ins.error;findings++;continue;
      }
      for(const s of suggestions){
        const review=reviewPayload(source,s);
        const ins=await db.from('studio_analysis_findings').insert({run_id:run.id,record_id:rr.data.id,finding_type:findingType(s),target_system:targetSystem(s),target_item_id:review.targetItemId,target_section_id:review.targetSectionId,confidence:Number(s.confidence||0),score_json:{reason:s.reason,action:s.action,existing:s.existing||null},explanation:s.reason||s.label||'Suggested knowledge action',target_json:s.existing||null,proposal_json:{review,suggestion:s},status:'candidate'});if(ins.error)throw ins.error;findings++;
      }
    }
    const done=await db.from('studio_analysis_runs').update({status:'complete',phase:'complete',progress:100,source_count:sources.length,record_count:records,finding_count:findings,summary_json:{characters:chars,scope,approvalRequired:true},completed_at:now(),updated_at:now()}).eq('id',run.id).select('*').single();if(done.error)throw done.error;
    return done.data;
  }catch(e:any){
    await db.from('studio_analysis_runs').update({status:'failed',phase:'failed',error_text:String(e?.message||e),completed_at:now(),updated_at:now()}).eq('id',run.id);
    throw e;
  }
}

export async function getCloudAnalysisRun(user:OrbitUser,workspaceId:string,id:string,includeRecords=false){
  await studioWorkspace(user,workspaceId,'studio_view');const db=getSupabaseAdmin();
  const run=await db.from('studio_analysis_runs').select('*').eq('workspace_id',workspaceId).eq('id',id).maybeSingle();if(run.error)throw run.error;if(!run.data)throw fail('Analysis run not found',404);
  const f=await db.from('studio_analysis_findings').select('*').eq('run_id',id).order('created_at');if(f.error)throw f.error;
  let records:any[]=[];if(includeRecords){const r=await db.from('studio_analysis_records').select('*').eq('run_id',id).order('created_at');if(r.error)throw r.error;records=r.data||[];}
  return {run:run.data,findings:f.data||[],records,processing:{state:'ready',mode:'serverless',residentProcess:false,operational:true}};
}

export async function createCloudAnalysisProposals(user:OrbitUser,workspaceId:string,runId:string,input:any={}){
  await studioWorkspace(user,workspaceId,'studio_analyse');const db=getSupabaseAdmin(),ids=new Set((input.findingIds||[]).map(String));
  const q=await db.from('studio_analysis_findings').select('*').eq('run_id',runId).in('finding_type',['add','update','merge','link','review']);if(q.error)throw q.error;
  const selected=(q.data||[]).filter((f:any)=>!ids.size||ids.has(String(f.id)));const proposals:any[]=[];
  for(const f of selected){
    const s=f.proposal_json?.suggestion||{},review=f.proposal_json?.review||{},source=review.source||{};
    let operation:any=null;
    if(s.kind==='profile_record_add')operation={type:'profile_record_add',profileId:s.profileId||null,sectionId:s.sectionId||'records',title:source.title||'Studio analysis finding',content:source.content||'',date:source.date||null,category:'analysis'};
    else if(s.kind==='library_item_update'&&s.itemId)operation={type:'library_item_update',itemId:s.itemId,fields:{content:source.content||''}};
    else if(s.kind==='knowledge_record_add')operation={type:'knowledge_record_add',role:s.role||'general_record_target',itemId:s.itemId||s.existing?.itemId||null,title:source.title||'Studio analysis finding',content:source.content||'',date:source.date||null,category:'analysis'};
    if(!operation)continue;
    const request=await createLibraryChangeRequest(user,workspaceId,{source:{system:'studio_analysis',runId,findingId:f.id,title:source.title||f.explanation},sourceSnapshot:{runId,findingId:f.id,review},summary:`Studio analysis: ${source.title||f.explanation||'finding'}`,reason:f.explanation||'',operations:[operation]});
    proposals.push(request);
    await db.from('studio_analysis_findings').update({proposal_json:{...(f.proposal_json||{}),libraryRequestId:request.id},updated_at:now()}).eq('id',f.id);
  }
  return proposals;
}
