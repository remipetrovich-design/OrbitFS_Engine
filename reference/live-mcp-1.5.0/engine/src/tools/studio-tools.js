import { z } from 'zod';
import { callWorkspaceApi } from '../services/workspace-client.js';
import { getStudioVentProfile } from './studio-vent.js';

const out = z.object({ ok:z.boolean(), message:z.string().optional(), workspaceId:z.string().optional() }).passthrough();
const clean = (v,max=255)=>String(v??'').trim().slice(0,max);

function base(workspaceId){ return `/internal/addons/mcp/workspaces/${encodeURIComponent(workspaceId)}/dispatch/studio`; }
function studioModeFor(identity,workspaceId){ return identity.studioModes?.[String(workspaceId)]==='vent'?'vent':'normal'; }
function setStudioMode(identity,workspaceId,mode){ identity.studioModes={...(identity.studioModes||{}),[String(workspaceId)]:mode==='vent'?'vent':'normal'}; return identity.studioModes[String(workspaceId)]; }
function assertWorkspace(workspaceId, allowed){
  if(!allowed.some((w)=>String(w.id)===String(workspaceId))) throw Object.assign(new Error('Workspace access denied'),{status:403,code:'WORKSPACE_ACCESS_DENIED'});
}
function receipt(message,data={},meta={}){
  return {content:[{type:'text',text:message}],structuredContent:{ok:true,message,...data},_meta:{...meta,studioUiState:data.uiState||data.studioUiState}};
}
export async function buildStudioUiState(identity,workspaceId){
  const profilePath=`/internal/addons/mcp/workspaces/${encodeURIComponent(workspaceId)}/profiles/catalog`;
  const [schema,status,records,sessions,profileCatalog]=await Promise.all([
    callWorkspaceApi(identity,`${base(workspaceId)}/schema`),
    callWorkspaceApi(identity,`${base(workspaceId)}/status`),
    callWorkspaceApi(identity,`${base(workspaceId)}/documents?compact=1&limit=40`),
    callWorkspaceApi(identity,`${base(workspaceId)}/sessions`),
    callWorkspaceApi(identity,profilePath).catch(()=>({profiles:[]}))
  ]);
  const ventProfile=await getStudioVentProfile(workspaceId,identity);
  return {workspaceId,schema,status,records:records.items||[],sessions:sessions.items||[],profiles:profileCatalog.profiles||[],studioMode:studioModeFor(identity,workspaceId),ventConfig:ventProfile.config,ventSaveLocation:ventProfile.saveLocation,initialView:'home'};
}export function registerStudioTools(server,deps){
  const {identity,meta,uiMeta,listWorkspaces,filterWorkspaces}=deps;
  const allowed=async()=>filterWorkspaces(await listWorkspaces(),identity);
  server.registerTool('studio_ui_state',{title:'Studio internal UI state',description:'Internal app-only state endpoint for the Studio ChatGPT UI. workspaceId may be omitted to load the current or first accessible workspace.',inputSchema:{workspaceId:z.string().optional()},outputSchema:out,annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},_meta:{...meta,ui:{visibility:['app']}}},async({workspaceId})=>{
    const workspaceList=await allowed();
    const resolved=workspaceId||identity.currentWorkspaceId||workspaceList.find(w=>w.status==='active')?.id||workspaceList[0]?.id;
    if(!resolved) throw Object.assign(new Error('No Studio-enabled workspace is available'),{status:404,code:'NO_STUDIO_WORKSPACE'});
    assertWorkspace(resolved,workspaceList); identity.currentWorkspaceId=resolved;
    const uiState=await buildStudioUiState(identity,resolved);
    uiState.workspaces=workspaceList.map(w=>({id:String(w.id),name:w.name||w.id,status:w.status||'active'}));
    return receipt('Studio UI refreshed.',{workspaceId:resolved,uiState},{...meta,ui:{visibility:['app']}});
  });
  server.registerTool('studio_set_mode',{title:'Set Studio writing mode',description:'Set the current ChatGPT Studio session to normal writing or pure Vent Mode. Vent Mode preserves the user\'s wording, tone and first-person perspective, avoids unsolicited rewriting/reframing, and keeps Studio records private unless the user explicitly submits them to Library. Platform safety requirements still apply.',inputSchema:{workspaceId:z.string(),mode:z.enum(['normal','vent'])},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async({workspaceId,mode})=>{
    assertWorkspace(workspaceId,await allowed()); identity.currentWorkspaceId=workspaceId; setStudioMode(identity,workspaceId,mode);
    const ventProfile=await getStudioVentProfile(workspaceId,identity);
    const uiState=await buildStudioUiState(identity,workspaceId);
    const behaviourInstructions=mode==='vent'
      ? ventProfile.behaviourInstructions
      : 'Studio normal writing mode is active.';
    return receipt(mode==='vent'?'Studio Vent Mode enabled.':'Studio Vent Mode disabled.',{workspaceId,studioMode:mode,behaviourInstructions,ventConfig:ventProfile.config,ventSaveLocation:ventProfile.saveLocation,uiState},uiMeta);
  });
  server.registerTool('studio_get_schema',{title:'Get Studio schema',description:'Use this when ChatGPT needs current Studio journal/document types, statuses, metadata fields and supported features before creating or editing records.',inputSchema:{workspaceId:z.string()},outputSchema:out,annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},_meta:meta},async({workspaceId})=>{
    assertWorkspace(workspaceId,await allowed()); const schema=await callWorkspaceApi(identity,`${base(workspaceId)}/schema`);
    return receipt('Studio schema loaded.',{workspaceId,schema},meta);
  });
  server.registerTool('studio_list_records',{title:'List Studio records',description:'Use this when ChatGPT needs to find journals or documents. Returns compact metadata by default without loading full record bodies.',inputSchema:{workspaceId:z.string(),kind:z.enum(['journal','document','generated']).optional(),type:z.string().optional(),status:z.enum(['draft','final','archived']).optional(),tag:z.string().optional(),profileId:z.string().optional(),q:z.string().optional(),limit:z.number().int().min(1).max(200).optional()},outputSchema:out,annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},_meta:meta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); const p=new URLSearchParams({compact:'1',limit:String(args.limit||50)});
    for(const k of ['kind','type','status','tag','profileId','q']) if(args[k]) p.set(k,String(args[k]));
    const r=await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents?${p}`); return receipt(`${r.items?.length||0} Studio record${r.items?.length===1?'':'s'} found.`,{workspaceId:args.workspaceId,records:r.items||[]},meta);
  });  server.registerTool('studio_get_record',{title:'Get Studio record',description:'Use this when ChatGPT needs one journal/document body or its current metadata after selecting it from compact Studio results.',inputSchema:{workspaceId:z.string(),recordId:z.string()},outputSchema:out,annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},_meta:meta},async({workspaceId,recordId})=>{
    assertWorkspace(workspaceId,await allowed()); const [r,a]=await Promise.all([callWorkspaceApi(identity,`${base(workspaceId)}/documents/${encodeURIComponent(recordId)}`),callWorkspaceApi(identity,`${base(workspaceId)}/documents/${encodeURIComponent(recordId)}/proposals`).catch(()=>({requests:[]}))]);
    return receipt(`Loaded Studio ${r.item?.kind||'record'}: ${r.item?.title||recordId}`,{workspaceId,record:r.item,approvals:a.requests||[]},meta);
  });
  server.registerTool('studio_create_record',{title:'Create Studio journal or document',description:'Use this for a one-shot journal entry or document. For an ongoing ChatGPT journaling conversation, prefer studio_session so later messages can continue the same draft safely. Studio owns validation, permissions, revisioning and storage.',inputSchema:{workspaceId:z.string(),kind:z.enum(['journal','document']),type:z.string(),title:z.string().optional(),content:z.string().optional(),summary:z.string().optional(),entryDate:z.string().optional(),tags:z.array(z.string()).optional(),profileIds:z.array(z.string()).optional(),profileTargetId:z.string().optional(),profileSectionId:z.string().optional(),metadata:z.record(z.any()).optional()},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); const ventActive=studioModeFor(identity,args.workspaceId)==='vent'||args.metadata?.studioMode==='vent';
    const content=args.content||''; let title=clean(args.title||'',180);
    let saveLocation;
    let tags=args.tags||[];
    let metadata=args.metadata||{};
    if(ventActive){
      const ventProfile=await getStudioVentProfile(args.workspaceId,identity);
      if(!title&&ventProfile.config.titleMode==='ask') throw Object.assign(new Error('Vent title required by this workspace Vent Mode configuration'),{status:400,code:'STUDIO_VENT_TITLE_REQUIRED'});
      if(!title&&ventProfile.config.titleMode==='auto') title=clean(content.split(/\r?\n/).map((x)=>x.trim()).find(Boolean)||'Untitled',180);
      title=ventProfile.formatTitle(title||'Untitled');
      saveLocation=ventProfile.saveLocation;
      tags=[...new Set(['vent',...tags])];
      metadata={...metadata,studioMode:'vent',preserveRaw:ventProfile.config.retainRaw!==false,ownerOnly:true,userEyesOnly:true,category:metadata.category||'private',ventConfig:{behaviour:ventProfile.config.behaviour,titleMode:ventProfile.config.titleMode,includeDateTime:ventProfile.config.includeDateTime,sectionHeadings:ventProfile.config.sectionHeadings,summary:ventProfile.config.summary,tags:ventProfile.config.tags}};
    } else if(!title) title='Untitled';
    const body={kind:ventActive?'journal':args.kind,type:ventActive?'vent':args.type,subtype:ventActive?'vent':args.type,title,content,summary:ventActive&&metadata.ventConfig?.summary==='none'?undefined:args.summary,entryDate:args.entryDate,tags,profileIds:args.profileIds||[],profileTargetId:args.profileTargetId,profileSectionId:args.profileSectionId,metadata,saveLocation};
    const r=await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents`,{method:'POST',body}); const uiState=await buildStudioUiState(identity,args.workspaceId); uiState.initialView=(ventActive||args.kind==='journal')?'journals':'documents'; uiState.selectedRecord=r.item;
    return receipt(`${ventActive?'Vent':args.kind==='journal'?'Journal':'Document'} created: ${r.item?.title||args.title}`,{workspaceId:args.workspaceId,record:r.item,uiState},uiMeta);
  });
  server.registerTool('studio_update_record',{title:'Update Studio record',description:'Use this when the user asks ChatGPT to edit an existing Studio journal/document. Content changes are revisioned by Studio.',inputSchema:{workspaceId:z.string(),recordId:z.string(),title:z.string().optional(),type:z.string().optional(),content:z.string().optional(),summary:z.string().optional(),entryDate:z.string().optional(),tags:z.array(z.string()).optional(),profileIds:z.array(z.string()).optional(),profileTargetId:z.string().optional(),profileSectionId:z.string().optional(),metadata:z.record(z.any()).optional(),changeNote:z.string().optional()},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); const body={...args}; delete body.workspaceId; delete body.recordId; if(args.type)body.subtype=args.type;
    const r=await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}`,{method:'PATCH',body}); const uiState=await buildStudioUiState(identity,args.workspaceId); uiState.selectedRecord=r.item;
    return receipt(`Studio record updated: ${r.item?.title||args.recordId}`,{workspaceId:args.workspaceId,record:r.item,uiState},uiMeta);
  });  server.registerTool('studio_append',{title:'Append to Studio record or session',description:'Use this when the user says to add what they just said to an existing Studio journal/document or active Studio session.',inputSchema:{workspaceId:z.string(),recordId:z.string().optional(),sessionId:z.string().optional(),text:z.string(),changeNote:z.string().optional()},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); let record=null,session=null; let sessionId=args.sessionId;
    if(!args.recordId&&!sessionId){const active=(await callWorkspaceApi(identity,`${base(args.workspaceId)}/sessions?status=active`)).items||[];if(active.length===1)sessionId=active[0].id;else if(active.length>1)throw Object.assign(new Error('Multiple active Studio sessions exist; choose which journal session to continue.'),{status:409,code:'Studio_SESSION_AMBIGUOUS'});else throw Object.assign(new Error('No active Studio session exists and no recordId was supplied.'),{status:409,code:'Studio_NO_ACTIVE_SESSION'});}
    if(sessionId){const r=await callWorkspaceApi(identity,`${base(args.workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,{method:'PATCH',body:{append:args.text}});session=r.item;}
    else {const current=(await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}`)).item; const content=`${current.content_text||''}${current.content_text?'\n\n':''}${args.text}`;record=(await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}`,{method:'PATCH',body:{content,changeNote:args.changeNote||'Appended through ChatGPT'}})).item;}
    const uiState=await buildStudioUiState(identity,args.workspaceId); if(record)uiState.selectedRecord=record; return receipt(session?'Studio session updated.':`Appended to ${record?.title||'Studio record'}.`,{workspaceId:args.workspaceId,record,session,uiState},uiMeta);
  });
  server.registerTool('studio_record_action',{title:'Change Studio record status or restore revision',description:'Use this when the user asks to finalize, return to draft, archive, or restore a Studio record revision.',inputSchema:{workspaceId:z.string(),recordId:z.string(),action:z.enum(['finalize','draft','archive','restore-revision']),revisionNo:z.number().int().positive().optional()},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:true,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); let path=`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}/${args.action}`; const body=args.action==='restore-revision'?{revisionNo:args.revisionNo}:{};
    const r=await callWorkspaceApi(identity,path,{method:'POST',body}); const uiState=await buildStudioUiState(identity,args.workspaceId); uiState.selectedRecord=r.item; return receipt(`Studio record ${args.action}.`,{workspaceId:args.workspaceId,record:r.item,uiState},uiMeta);
  });
  server.registerTool('studio_submit_approval',{title:'Submit Studio record for Library approval',description:'Use this when the user wants a Studio entry published into Base Library/Profile knowledge. This creates a Base approval request; it does not bypass approval.',inputSchema:{workspaceId:z.string(),recordId:z.string(),summary:z.string().optional(),reason:z.string().optional(),useRoutingSuggestions:z.boolean().optional(),routingSuggestionIndexes:z.array(z.number().int().min(0)).optional()},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); const r=await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}/proposals`,{method:'POST',body:{summary:args.summary,reason:args.reason,useRoutingSuggestions:args.useRoutingSuggestions===true,routingSuggestionIndexes:args.routingSuggestionIndexes||[]}}); const uiState=await buildStudioUiState(identity,args.workspaceId); uiState.selectedRecord=(await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}`)).item; uiState.approvals=(await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}/proposals`).catch(()=>({requests:[]}))).requests||[]; return receipt('Studio entry submitted to Base approval.',{workspaceId:args.workspaceId,request:r.request,approvals:uiState.approvals,uiState},uiMeta);
  });
  server.registerTool('studio_analyse_routing',{title:'Analyse Studio routing',description:'Analyse a Studio entry and suggest its Base Library/Profile destinations. Base determines knowledge operation type; APEX may contribute learned workspace destination signals when installed.',inputSchema:{workspaceId:z.string(),recordId:z.string()},outputSchema:out,annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed());
    const r=await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}/analyse-routing`,{method:'POST',body:{}});
    const uiState=await buildStudioUiState(identity,args.workspaceId); uiState.selectedRecord=(await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.recordId)}`)).item; uiState.routingAnalysis=r.analysis||null;
    const top=r.analysis?.suggestions?.[0]; const message=top?`Suggested: ${top.label||top.kind} (${Math.round(Number(top.confidence||0)*100)}%).`:'No routing suggestion was produced.';
    return receipt(message,{workspaceId:args.workspaceId,analysis:r.analysis||null,uiState},uiMeta);
  });
  server.registerTool('studio_list_revisions',{title:'List Studio record revisions',description:'Use this when ChatGPT or the Studio app needs revision history for a selected journal or document.',inputSchema:{workspaceId:z.string(),recordId:z.string()},outputSchema:out,annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},_meta:meta},async({workspaceId,recordId})=>{
    assertWorkspace(workspaceId,await allowed()); const r=await callWorkspaceApi(identity,`${base(workspaceId)}/documents/${encodeURIComponent(recordId)}/revisions`); return receipt(`${r.items?.length||0} Studio revision${r.items?.length===1?'':'s'} found.`,{workspaceId,recordId,revisions:r.items||[]},meta);
  });
  server.registerTool('studio_list_links',{title:'List Studio record links',description:'Use this when ChatGPT or the Studio app needs the structured links attached to a journal or document.',inputSchema:{workspaceId:z.string(),recordId:z.string()},outputSchema:out,annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false},_meta:meta},async({workspaceId,recordId})=>{
    assertWorkspace(workspaceId,await allowed()); const r=await callWorkspaceApi(identity,`${base(workspaceId)}/links?documentId=${encodeURIComponent(recordId)}`); return receipt(`${r.items?.length||0} Studio link${r.items?.length===1?'':'s'} found.`,{workspaceId,recordId,links:r.items||[]},meta);
  });
  server.registerTool('studio_manage_link',{title:'Manage Studio record link',description:'Add or remove a structured Studio link between a journal/document and a profile, document, file or event.',inputSchema:{workspaceId:z.string(),action:z.enum(['add','remove']),recordId:z.string().optional(),linkId:z.string().optional(),targetType:z.enum(['profile','document','file','event']).optional(),targetId:z.string().optional(),relation:z.string().optional(),metadata:z.record(z.any()).optional()},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); let r; if(args.action==='add'){if(!args.recordId||!args.targetId)throw Object.assign(new Error('recordId and targetId are required'),{status:400});r=await callWorkspaceApi(identity,`${base(args.workspaceId)}/links`,{method:'POST',body:{documentId:args.recordId,targetType:args.targetType||'document',targetId:args.targetId,relation:args.relation||'related',metadata:args.metadata||{}}});}else{if(!args.linkId)throw Object.assign(new Error('linkId is required'),{status:400});r=await callWorkspaceApi(identity,`${base(args.workspaceId)}/links/${encodeURIComponent(args.linkId)}`,{method:'DELETE'});} const uiState=await buildStudioUiState(identity,args.workspaceId); return receipt(`Studio link ${args.action} complete.`,{workspaceId:args.workspaceId,result:r,uiState},uiMeta);
  });
  server.registerTool('studio_create_document_from_record',{title:'Create Studio document from record',description:'Use this when the user asks ChatGPT to turn an existing journal or Studio record into a new document while preserving a traceable derived-from link.',inputSchema:{workspaceId:z.string(),sourceRecordId:z.string(),type:z.string().optional(),title:z.string().optional(),summary:z.string().optional(),content:z.string().optional(),tags:z.array(z.string()).optional(),profileIds:z.array(z.string()).optional()},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); const source=(await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents/${encodeURIComponent(args.sourceRecordId)}`)).item; if(!source)throw Object.assign(new Error('Source Studio record not found'),{status:404}); const body={kind:'document',type:args.type||'general',subtype:args.type||'general',title:args.title||`${source.title} - Document`,content:args.content!==undefined?args.content:(source.content_text||''),summary:args.summary!==undefined?args.summary:(source.summary||''),tags:args.tags||source.tags||[],profileIds:args.profileIds||source.profile_ids||source.profileIds||[],metadata:{...(source.metadata_json||{}),sourceRecordId:source.id,sourceRecordKind:source.kind}}; const created=(await callWorkspaceApi(identity,`${base(args.workspaceId)}/documents`,{method:'POST',body})).item; let link=null; try{link=await callWorkspaceApi(identity,`${base(args.workspaceId)}/links`,{method:'POST',body:{documentId:created.id,targetType:'document',targetId:source.id,relation:'derived-from',metadata:{createdThrough:'mcp'}}});}catch{} const uiState=await buildStudioUiState(identity,args.workspaceId);uiState.initialView='documents';uiState.selectedRecord=created;return receipt(`Document created from ${source.title}.`,{workspaceId:args.workspaceId,record:created,sourceRecord:source,link,uiState},uiMeta);
  });
  server.registerTool('studio_session',{title:'Manage Studio journaling session',description:'Use this when ChatGPT needs a working Studio journaling session: start, append, finalize into a journal, inspect, or discard.',inputSchema:{workspaceId:z.string(),action:z.enum(['start','append','finalize','discard','list']),sessionId:z.string().optional(),title:z.string().optional(),type:z.string().optional(),content:z.string().optional(),entryDate:z.string().optional(),final:z.boolean().optional()},outputSchema:out,annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},_meta:uiMeta},async(args)=>{
    assertWorkspace(args.workspaceId,await allowed()); let result;
    if(args.action==='list') result=await callWorkspaceApi(identity,`${base(args.workspaceId)}/sessions`);
    else if(args.action==='start') result=await callWorkspaceApi(identity,`${base(args.workspaceId)}/sessions`,{method:'POST',body:{title:args.title||'Journal session',sessionType:args.type||'standard',content:args.content||''}});
    else {if(!args.sessionId)throw Object.assign(new Error('sessionId is required'),{status:400}); const suffix=args.action==='append'?'':`/${args.action}`; const method=args.action==='append'?'PATCH':'POST'; const body=args.action==='append'?{append:args.content||''}:{title:args.title,entryDate:args.entryDate,final:args.final}; result=await callWorkspaceApi(identity,`${base(args.workspaceId)}/sessions/${encodeURIComponent(args.sessionId)}${suffix}`,{method,body});}
    const uiState=await buildStudioUiState(identity,args.workspaceId); uiState.initialView='journals'; return receipt(`Studio session ${args.action} complete.`,{workspaceId:args.workspaceId,...result,uiState},uiMeta);
  });
}