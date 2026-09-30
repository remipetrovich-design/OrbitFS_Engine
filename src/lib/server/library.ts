// @ts-nocheck
import crypto from 'node:crypto';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { getWorkspace, managementPermissions, requireWorkspaceAccess, workspaceMembers, workspaceRole } from '$lib/server/workspaces';
import { profileCatalog, profileKnowledgeProjection, updateProfile } from '$lib/server/workspace-profiles.js';
import { buildKnowledgeIntelligence, buildFactRelations, factRelationLinks, retrievalIntelligenceBoost } from '$lib/server/knowledge-intelligence.js';
import { buildStructuredRecords } from '$lib/server/knowledge-structure.js';
import type { OrbitUser } from '$lib/server/auth';
import { getKnowledgeArchitecture, resolveKnowledgeItemPolicy } from '$lib/server/knowledge-architecture';

const now = () => new Date().toISOString();
const uid = (prefix:string) => `${prefix}_${crypto.randomUUID()}`;
const text = (value:any,max=500) => String(value ?? '').trim().slice(0,max);
const list = (value:any) => [...new Set((Array.isArray(value)?value:String(value||'').split(',')).map((v:any)=>text(v,96)).filter(Boolean))];

export const LIBRARY_SETTINGS_DEFAULTS = Object.freeze({
  freshnessMs:30000,
  maxFreshRefresh:100,
  ingestMaxItems:1000,
  ingestBatch:100,
  autoIndexKnowledge:true,
  retrievalLimit:12,
  retrievalMaxChars:12000,
  analysisMaxItems:250,
  analysisMaxCharacters:1500000
});
export const LIBRARY_SAFEGUARDS = Object.freeze({
  approvalBeforeAuthoritativeWrites:true,
  staleTargetValidation:true,
  writeVerificationRollback:true,
  directBinaryDocumentEdits:false,
  filesystemMode:false,
  canonicalStore:'supabase-library-memory'
});

export const LIBRARY_ROLES = [
  {id:'core_knowledge',label:'Core Knowledge',sourceKinds:['knowledge'],loadMode:'full'},
  {id:'core_profile',label:'Core Profile',sourceKinds:['profile'],loadMode:'full'},
  {id:'incident_log',label:'Event / Incident Log',sourceKinds:['knowledge']},
  {id:'timeline',label:'Timeline',sourceKinds:['knowledge']},
  {id:'relationship_timeline',label:'Secondary Timeline',sourceKinds:['knowledge']},
  {id:'knowledge_target',label:'Knowledge Target',sourceKinds:['knowledge']},
  {id:'reference_target',label:'Reference Target',sourceKinds:['knowledge']},
  {id:'evidence_target',label:'Source Material Target',sourceKinds:['knowledge']},
  {id:'profile_record_target',label:'Profile Record Target',sourceKinds:['profile']},
  {id:'general_record_target',label:'General Record Target',sourceKinds:['knowledge']}
] as const;
export const LIBRARY_LIFECYCLES = ['unclassified','current','final','final_locked','old','draft','archived','reference_only','deprecated'] as const;
const roleIds=new Set(LIBRARY_ROLES.map(x=>x.id));
const lifecycleIds=new Set<string>(LIBRARY_LIFECYCLES as readonly string[]);
const roles=(value:any)=>list(value).map((x:any)=>String(x).toLowerCase().replace(/[^a-z0-9_-]+/g,'_')).filter((x:any)=>roleIds.has(x));
const lifecycle=(value:any)=>lifecycleIds.has(String(value||'').toLowerCase())?String(value).toLowerCase():'unclassified';
export const LIBRARY_LIFECYCLE_DEFINITIONS = [
  {id:'unclassified',label:'Unclassified',writable:true,description:'Not classified yet.'},
  {id:'current',label:'Current',writable:true,description:'Current authoritative knowledge.'},
  {id:'final',label:'Final',writable:false,description:'Final authoritative knowledge retained without further direct writes.'},
  {id:'final_locked',label:'Final / locked',writable:false,description:'Final reference content; changes require a new revision or target.'},
  {id:'old',label:'Old',writable:false,description:'Older retained material.'},
  {id:'draft',label:'Draft',writable:true,description:'Work in progress.'},
  {id:'archived',label:'Archived',writable:false,description:'Archived material retained for history.'},
  {id:'reference_only',label:'Reference only',writable:false,description:'Reference material, not an update target.'},
  {id:'deprecated',label:'Deprecated',writable:false,description:'Deprecated knowledge; do not load or target by default.'}
] as const;

function blank(workspaceId:string) {
	return { version:9, workspaceId, items:[], collections:[], groups:[], categories:[], links:[], usage:[], sections:[], events:[], sourceHistory:[], autoLinks:[], entities:[], entityMentions:[], facts:[], factRelations:[], records:[], changeRequests:[], settings:{...LIBRARY_SETTINGS_DEFAULTS}, createdAt:now(), updatedAt:now() } as any;
}

export async function readLibrary(workspaceId:string) {
	const db=getSupabaseAdmin();
	const r=await db.from('orbitfs_library_state').select('state,updated_at').eq('workspace_id',workspaceId).maybeSingle();
	if(r.error) throw r.error;
	const state={...blank(workspaceId),...(r.data?.state||{}),workspaceId,version:9};
	state.groups ||= []; state.categories ||= []; state.changeRequests ||= []; state.collections ||= [];
	const rawSettings=state.settings||{};
	state.settings={...LIBRARY_SETTINGS_DEFAULTS,...rawSettings,
		ingestMaxItems:Number(rawSettings.ingestMaxItems ?? rawSettings.scanMaxFiles ?? LIBRARY_SETTINGS_DEFAULTS.ingestMaxItems),
		ingestBatch:Number(rawSettings.ingestBatch ?? rawSettings.scanRegisterBatch ?? LIBRARY_SETTINGS_DEFAULTS.ingestBatch),
		autoIndexKnowledge:rawSettings.autoIndexKnowledge ?? rawSettings.scanIndexByDefault ?? LIBRARY_SETTINGS_DEFAULTS.autoIndexKnowledge};
	for(const item of state.items||[]){ item.lifecycleState=lifecycle(item.lifecycleState ?? item.lifecycle); item.lifecycle=item.lifecycleState; item.roles=roles(item.roles); }
	state.updatedAt=r.data?.updated_at || state.updatedAt;
	return state;
}
export async function saveLibrary(workspaceId:string,state:any) {
	const db=getSupabaseAdmin(); const updatedAt=now(); state.updatedAt=updatedAt;
	const r=await db.from('orbitfs_library_state').upsert({workspace_id:workspaceId,state,updated_at:updatedAt},{onConflict:'workspace_id'});
	if(r.error) throw r.error; return state;
}

export async function libraryContext(user:OrbitUser,workspaceId:string) {
	const workspace=await getWorkspace(workspaceId); const role=await requireWorkspaceAccess(user,workspace);
	const management=await managementPermissions(user,workspace,role);
	return { workspace, role, canManage:Boolean(management.manage_library), members:await workspaceMembers(workspaceId) };
}

export async function getLibrarySettings(user:OrbitUser,workspaceId:string){
  const ctx=await libraryContext(user,workspaceId);
  const state=await readLibrary(workspaceId);
  return {settings:{...LIBRARY_SETTINGS_DEFAULTS,...(state.settings||{})},safeguards:LIBRARY_SAFEGUARDS,canManage:ctx.canManage};
}
export async function updateLibrarySettings(user:OrbitUser,workspaceId:string,input:any={}){
  const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage);
  const state=await readLibrary(workspaceId),raw=input.settings&&typeof input.settings==='object'?input.settings:input;
  const clampInt=(v:any,min:number,max:number,fallback:number)=>Math.max(min,Math.min(max,Math.round(Number.isFinite(Number(v))?Number(v):fallback)));
  state.settings={
    freshnessMs:clampInt(raw.freshnessMs,1000,300000,LIBRARY_SETTINGS_DEFAULTS.freshnessMs),
    maxFreshRefresh:clampInt(raw.maxFreshRefresh,1,2000,LIBRARY_SETTINGS_DEFAULTS.maxFreshRefresh),
    ingestMaxItems:clampInt(raw.ingestMaxItems ?? raw.scanMaxFiles,50,10000,LIBRARY_SETTINGS_DEFAULTS.ingestMaxItems),
    ingestBatch:clampInt(raw.ingestBatch ?? raw.scanRegisterBatch,1,500,LIBRARY_SETTINGS_DEFAULTS.ingestBatch),
    autoIndexKnowledge:(raw.autoIndexKnowledge ?? raw.scanIndexByDefault)!==false,
    retrievalLimit:clampInt(raw.retrievalLimit,1,50,LIBRARY_SETTINGS_DEFAULTS.retrievalLimit),
    retrievalMaxChars:clampInt(raw.retrievalMaxChars,500,50000,LIBRARY_SETTINGS_DEFAULTS.retrievalMaxChars),
    analysisMaxItems:clampInt(raw.analysisMaxItems,1,500,LIBRARY_SETTINGS_DEFAULTS.analysisMaxItems),
    analysisMaxCharacters:clampInt(raw.analysisMaxCharacters,10000,10000000,LIBRARY_SETTINGS_DEFAULTS.analysisMaxCharacters)
  };
  await saveLibrary(workspaceId,state);
  return {settings:state.settings,safeguards:LIBRARY_SAFEGUARDS,canManage:true};
}

function effectiveLifecycle(item:any,policy:any){
	if(!policy)return item.lifecycleState||item.lifecycle||'unclassified';
	if(policy.state==='archive')return 'archived';
	if(policy.state==='superseded')return 'old';
	if(policy.state==='draft')return 'draft';
	if(policy.usage==='reference')return policy.state==='final'?'final':'reference_only';
	if(policy.state==='final')return policy.protection==='locked'?'final_locked':'final';
	return 'current';
}
function architectureBoost(policy:any){
	if(!policy)return 0;
	return (policy.usage==='primary'?18:4)+(policy.state==='active'?12:policy.state==='final'?8:policy.state==='draft'?2:-8)+Number(policy.priority||0)/10;
}
export async function presentLibrary(user:OrbitUser,workspaceId:string) {
	const [state,ctx,architecture]=await Promise.all([readLibrary(workspaceId),libraryContext(user,workspaceId),getKnowledgeArchitecture(workspaceId)]);
	for(const item of state.items||[]){const policy=resolveKnowledgeItemPolicy(architecture,item.id);item.knowledgeArchitecture=policy;item.effectiveLifecycleState=effectiveLifecycle(item,policy);item.effectiveLoadMode=policy?.usage==='primary'&&Number(policy?.priority||0)>=80?'full':'smart';}
	const stats={ items:state.items.length, collections:state.collections.length, groups:state.groups.length, categories:state.categories.length, links:state.links.length, sections:state.sections.length, events:state.events.length, records:state.records.length, facts:state.facts.length, relations:state.factRelations.length, changeRequests:state.changeRequests.length };
	return {...state,roleDefinitions:LIBRARY_ROLES,lifecycleDefinitions:LIBRARY_LIFECYCLE_DEFINITIONS,canManage:ctx.canManage,members:ctx.members,stats};
}

function requireManage(canManage:boolean) {
	if(!canManage) throw Object.assign(new Error('Library management permission required'),{status:403,code:'LIBRARY_MANAGE_REQUIRED'});
}
export async function createLibraryItem(user:OrbitUser,workspaceId:string,input:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId);
	const provider=text(input.provider || input.source?.provider || (input.profileId?'base.profiles':'library.native'),120);
	if(provider==='base.files')throw Object.assign(new Error('File-backed Knowledge registration is retired. Store canonical content in Library/Memory instead.'),{status:410,code:'LIBRARY_FILE_PROVIDER_RETIRED'});
	if(!['library.native','memory.knowledge','base.profiles'].includes(provider))throw Object.assign(new Error('Unsupported Library provider'),{status:400,code:'LIBRARY_PROVIDER_UNSUPPORTED'});
	const locator=input.source?.locator || (provider==='base.profiles'?{profileId:text(input.profileId,160)}:{knowledgeId:text(input.documentId||input.knowledgeId||crypto.randomUUID(),160)});
	const key=`${provider}:${JSON.stringify(locator)}`; const existing=state.items.find((x:any)=>`${x.source?.provider}:${JSON.stringify(x.source?.locator||{})}`===key);
	if(existing) return {item:existing,existing:true};
	const item:any={ id:uid('lib'),workspaceId,kind:provider==='base.profiles'?'profile':(provider==='library.native'||provider==='memory.knowledge')?'knowledge':text(locator.sourceKind||'file',32),name:text(input.name || locator.path || locator.profileId || 'Untitled document',180),description:text(input.description,1000),category:text(input.category,120),tags:list(input.tags),purposes:list(input.purposes),aliases:list(input.aliases),importance:Number(input.importance ?? .5),status:text(input.status||'active',32),lifecycle:lifecycle(input.lifecycleState ?? input.lifecycle),lifecycleState:lifecycle(input.lifecycleState ?? input.lifecycle),roles:roles(input.roles),visibility:text(input.visibility||'workspace',32),viewerIds:Array.isArray(input.viewerIds)?input.viewerIds:[],editorIds:Array.isArray(input.editorIds)?input.editorIds:[],ownerUserId:user.id,versionLabel:text(input.versionLabel,80),guards:input.guards||{},metadata:input.metadata||{},groupId:input.groupId||null,currentTarget:input.currentTarget===true,targetPriority:Number(input.targetPriority??50),content:(provider==='library.native'||provider==='memory.knowledge')?String(input.content||''):undefined,contentFormat:(provider==='library.native'||provider==='memory.knowledge')?text(input.contentFormat||'markdown',32):undefined,source:{provider,locator},createdAt:now(),updatedAt:now(),createdBy:user.username };
	state.items.push(item); await saveLibrary(workspaceId,state);
	if(['library.native','memory.knowledge'].includes(provider)&&state.settings?.autoIndexKnowledge!==false&&!item.guards?.indexingLocked){
		const indexed=await indexLibraryItem(user,workspaceId,item.id).catch(()=>null);
		if(indexed?.item)return {item:indexed.item,existing:false,indexed:true};
	}
	return {item,existing:false,indexed:false};
}

export async function updateLibraryItem(user:OrbitUser,workspaceId:string,id:string,input:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const item=state.items.find((x:any)=>x.id===id);
	if(!item) throw Object.assign(new Error('Knowledge item not found'),{status:404});
	const architecture=await getKnowledgeArchitecture(workspaceId),policy=resolveKnowledgeItemPolicy(architecture,id);
	if(input.content!==undefined&&(policy?.protection==='locked'||['archive','superseded'].includes(String(policy?.state||''))))throw Object.assign(new Error('Knowledge Setup protects this content from direct writes'),{status:423,code:'KNOWLEDGE_ITEM_LOCKED',knowledgePolicy:policy});
	for(const key of ['name','description','category','status','visibility','versionLabel']) if(input[key]!==undefined) item[key]=text(input[key],key==='description'?1000:180);
	for(const key of ['tags','purposes','aliases']) if(input[key]!==undefined) item[key]=list(input[key]);
	if(input.roles!==undefined) item.roles=roles(input.roles); if(input.lifecycle!==undefined || input.lifecycleState!==undefined){ item.lifecycle=lifecycle(input.lifecycleState ?? input.lifecycle); item.lifecycleState=item.lifecycle; }
	for(const key of ['importance','viewerIds','editorIds','guards','metadata','groupId','currentTarget','targetPriority']) if(input[key]!==undefined) item[key]=input[key];
	if(['library.native','memory.knowledge'].includes(item.source?.provider)&&input.content!==undefined) item.content=String(input.content); if(['library.native','memory.knowledge'].includes(item.source?.provider)&&input.contentFormat!==undefined)item.contentFormat=text(input.contentFormat,32);
	const contentChanged=['library.native','memory.knowledge'].includes(item.source?.provider)&&input.content!==undefined;
	item.updatedAt=now(); item.updatedBy=user.username; await saveLibrary(workspaceId,state);
	if(contentChanged&&state.settings?.autoIndexKnowledge!==false&&!item.guards?.indexingLocked){const indexed=await indexLibraryItem(user,workspaceId,id).catch(()=>null);if(indexed?.item)return {item:indexed.item,indexed:true};}
	return {item,indexed:false};
}export async function deleteLibraryItem(user:OrbitUser,workspaceId:string,id:string,force=false) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const item=state.items.find((x:any)=>x.id===id);
	if(!item) throw Object.assign(new Error('Knowledge item not found'),{status:404});
	const architecture=await getKnowledgeArchitecture(workspaceId),policy=resolveKnowledgeItemPolicy(architecture,id);
	if(policy?.protection==='locked'&&!force)throw Object.assign(new Error('Knowledge Setup protects this item from removal'),{status:423,code:'KNOWLEDGE_ITEM_LOCKED'});
	if(item.guards?.removalLocked && !force) throw Object.assign(new Error('Knowledge item removal is locked'),{status:423});
	state.items=state.items.filter((x:any)=>x.id!==id); state.sections=state.sections.filter((x:any)=>x.itemId!==id); state.events=state.events.filter((x:any)=>x.itemId!==id); state.records=state.records.filter((x:any)=>x.itemId!==id); state.facts=state.facts.filter((x:any)=>x.itemId!==id); state.links=state.links.filter((x:any)=>x.sourceItemId!==id&&x.targetItemId!==id); state.usage=state.usage.filter((x:any)=>x.itemId!==id);
	for(const c of state.collections) c.entries=(c.entries||[]).filter((e:any)=>e.itemId!==id);
	await saveLibrary(workspaceId,state); return {deleted:true,id};
}

export async function createCollection(user:OrbitUser,workspaceId:string,input:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId);
	const collection:any={id:uid('col'),workspaceId,name:text(input.name,180),description:text(input.description,1000),mode:text(input.mode||'live',32),visibility:text(input.visibility||'workspace',32),entries:Array.isArray(input.entries)?input.entries:[],directEntries:Array.isArray(input.entries)?input.entries:[],includeCollectionIds:Array.isArray(input.includeCollectionIds)?input.includeCollectionIds:[],sourceSelectors:Array.isArray(input.sourceSelectors)?input.sourceSelectors:[],tags:list(input.tags),purposes:list(input.purposes),rules:input.rules||{},metadata:input.metadata||{},createdAt:now(),updatedAt:now(),createdBy:user.username};
	if(!collection.name) throw Object.assign(new Error('Collection name is required'),{status:400}); state.collections.push(collection); await saveLibrary(workspaceId,state); return {collection};
}

export async function updateCollection(user:OrbitUser,workspaceId:string,id:string,input:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const collection=state.collections.find((x:any)=>x.id===id);
	if(!collection) throw Object.assign(new Error('Collection not found'),{status:404}); Object.assign(collection,input,{id,workspaceId,updatedAt:now(),updatedBy:user.username}); await saveLibrary(workspaceId,state); return {collection};
}export async function deleteCollection(user:OrbitUser,workspaceId:string,id:string) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const before=state.collections.length; state.collections=state.collections.filter((x:any)=>x.id!==id); if(before===state.collections.length) throw Object.assign(new Error('Collection not found'),{status:404}); await saveLibrary(workspaceId,state); return {deleted:true,id};
}

export async function createLink(user:OrbitUser,workspaceId:string,input:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId);
	if(!state.items.some((x:any)=>x.id===input.sourceItemId)||!state.items.some((x:any)=>x.id===input.targetItemId)) throw Object.assign(new Error('Knowledge link item not found'),{status:404});
	const link:any={id:uid('link'),workspaceId,sourceItemId:text(input.sourceItemId,160),sourceSectionId:input.sourceSectionId||null,targetItemId:text(input.targetItemId,160),targetSectionId:input.targetSectionId||null,relation:text(input.relation||'related_to',80),inverseRelation:input.inverseRelation?text(input.inverseRelation,80):null,origin:'manual',status:'confirmed',metadata:input.metadata||{},createdAt:now(),createdBy:user.username}; state.links.push(link); await saveLibrary(workspaceId,state); return {link};
}

export async function deleteLink(user:OrbitUser,workspaceId:string,id:string) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const before=state.links.length; state.links=state.links.filter((x:any)=>x.id!==id); if(before===state.links.length) throw Object.assign(new Error('Knowledge link not found'),{status:404}); await saveLibrary(workspaceId,state); return {deleted:true,id};
}

export async function createEvent(user:OrbitUser,workspaceId:string,input:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const event:any={id:uid('evt'),workspaceId,itemId:text(input.itemId,160),sectionId:input.sectionId||null,date:text(input.date||now().slice(0,10),40),title:text(input.title,240),description:text(input.description,2000),eventType:text(input.eventType||'event',80),origin:'manual',status:text(input.status||'confirmed',32),confidence:Number(input.confidence??1),createdAt:now(),createdBy:user.username}; state.events.push(event); await saveLibrary(workspaceId,state); return {event};
}export async function updateEvent(user:OrbitUser,workspaceId:string,id:string,input:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const event=state.events.find((x:any)=>x.id===id); if(!event) throw Object.assign(new Error('Knowledge event not found'),{status:404}); Object.assign(event,input,{id,workspaceId,updatedAt:now(),updatedBy:user.username}); await saveLibrary(workspaceId,state); return {event};
}
export async function deleteEvent(user:OrbitUser,workspaceId:string,id:string) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const before=state.events.length; state.events=state.events.filter((x:any)=>x.id!==id); if(before===state.events.length) throw Object.assign(new Error('Knowledge event not found'),{status:404}); await saveLibrary(workspaceId,state); return {deleted:true,id};
}

export async function scanLibraryFiles(_user:OrbitUser,_workspaceId:string,_input:any={}) {
	throw Object.assign(new Error('Filesystem scanning is retired in OrbitFS Cloud. Ingest content into Library/Memory instead.'),{status:410,code:'LIBRARY_SCAN_RETIRED'});
}
async function sourceText(_workspaceId:string,item:any) {
	if(['library.native','memory.knowledge'].includes(item.source?.provider)) return String(item.content||'');
	if(item.source?.provider==='base.files') throw Object.assign(new Error('Legacy file-backed Knowledge is read-only compatibility data and cannot be indexed as canonical Library content.'),{status:410,code:'LIBRARY_FILE_PROVIDER_RETIRED'});
	throw Object.assign(new Error('This Library source is not text-indexable'),{status:415});
}

export async function indexLibraryItem(user:OrbitUser,workspaceId:string,id:string) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const item=state.items.find((x:any)=>x.id===id); if(!item) throw Object.assign(new Error('Knowledge item not found'),{status:404}); if(item.guards?.indexingLocked) throw Object.assign(new Error('Knowledge indexing is locked'),{status:423});
	if(!['library.native','memory.knowledge'].includes(item.source?.provider))throw Object.assign(new Error('Only native Library/Memory knowledge is indexed by the canonical cloud index'),{status:415,code:'LIBRARY_NATIVE_INDEX_REQUIRED'});
	const content=(await sourceText(workspaceId,item)).replace(/\r\n?/g,'\n'); const lines=content.split('\n'); const sections:any[]=[]; let current:any={title:item.name,lineStart:1,level:1,lines:[]};
	const flush=(lineEnd:number)=>{const body=current.lines.join('\n').trim(); if(!body)return; const sectionKey=`${id}:${current.lineStart}:${current.title}`; sections.push({id:`sec_${crypto.createHash('sha256').update(sectionKey).digest('hex').slice(0,24)}`,workspaceId,itemId:id,title:current.title,level:current.level,headingPath:[current.title],lineStart:current.lineStart,lineEnd,preview:body.slice(0,500),wordCount:body.split(/\s+/).filter(Boolean).length,__content:body,indexedAt:now()});};
	for(let i=0;i<lines.length;i++){const m=lines[i].match(/^(#{1,6})\s+(.+)/);if(m){flush(i);current={title:m[2].trim(),lineStart:i+1,level:m[1].length,lines:[]};}else current.lines.push(lines[i]);} flush(lines.length);
	const profiles=await profileCatalog(workspaceId,ctx.role,user.id,user.role).catch(()=>({profiles:[]})); const intel=buildKnowledgeIntelligence({store:state,item,sections,profileCatalog:profiles}); const records=buildStructuredRecords({item,sections:intel.sections,entities:intel.entities,mentions:intel.mentions,previousRecords:state.records||[]});
	state.sections=state.sections.filter((x:any)=>x.itemId!==id).concat(intel.sections.map((section:any)=>({...section,content:section.__content||section.content||'',__content:undefined})));
	state.events=state.events.filter((x:any)=>x.itemId!==id||x.origin!=='indexer').concat(intel.events); state.entities=intel.entities; state.entityMentions=(state.entityMentions||[]).filter((x:any)=>x.itemId!==id).concat(intel.mentions); state.facts=(state.facts||[]).filter((x:any)=>x.itemId!==id).concat(intel.facts); state.records=(state.records||[]).filter((x:any)=>x.itemId!==id).concat(records);
	state.factRelations=buildFactRelations(state.facts,state.factRelations||[]); const relationLinks=factRelationLinks(state.factRelations,state.autoLinks||[]); state.autoLinks=[...(state.autoLinks||[]).filter((x:any)=>x.sourceItemId!==id&&x.targetItemId!==id&&x.origin!=='fact_engine'),...intel.links,...relationLinks];
	item.sectionCount=intel.sections.length; item.eventCount=intel.events.length; item.recordCount=records.length; item.entityMentionCount=intel.mentions.length; item.factCount=intel.facts.length; item.relationCount=state.factRelations.filter((x:any)=>x.sourceItemId===id||x.targetItemId===id).length; item.indexedAt=now(); item.sourceTracking={size:Buffer.byteLength(content),signature:crypto.createHash('sha256').update(content).digest('hex'),indexedAt:now(),sourceFormat:item.contentFormat||'markdown'}; state.sourceHistory.push({id:uid('chg'),itemId:id,indexedAt:now(),kind:'indexed',addedSections:intel.sections.length,changedSections:0,removedSections:0}); await saveLibrary(workspaceId,state); return {item,sections:state.sections.filter((x:any)=>x.itemId===id),events:intel.events,facts:intel.facts,records,indexed:true};
}
export async function registerScannedFiles(_user:OrbitUser,_workspaceId:string,_input:any) {
	throw Object.assign(new Error('Filesystem registration is retired in OrbitFS Cloud. Create or import Library knowledge instead.'),{status:410,code:'LIBRARY_SCAN_RETIRED'});
}

export async function retrieveLibrary(user:OrbitUser,workspaceId:string,input:any) {
	await libraryContext(user,workspaceId); const [state,architecture]=await Promise.all([readLibrary(workspaceId),getKnowledgeArchitecture(workspaceId)]); const q=text(input.query,500).toLowerCase(); const limit=Math.max(1,Math.min(50,Number(input.limit)||12)); const collectionId=text(input.collectionId,160); let allowed:Set<string>|null=null;
	if(collectionId){const c=state.collections.find((x:any)=>x.id===collectionId); if(c) allowed=new Set((c.entries||[]).map((e:any)=>e.itemId));}
	const words=q.split(/\s+/).filter(Boolean); const results=state.sections.filter((s:any)=>!allowed||allowed.has(s.itemId)).map((s:any)=>{const item=state.items.find((x:any)=>x.id===s.itemId);const hay=`${s.title} ${s.preview} ${s.content||''}`.toLowerCase();const lexical=words.reduce((n,w)=>n+(hay.includes(w)?1:0),0);const policy=item?resolveKnowledgeItemPolicy(architecture,item.id):null;const score=lexical*10+retrievalIntelligenceBoost(q,item||{},s,state.entities||[],state.entityMentions||[],state.facts||[])+architectureBoost(policy);return {...s,score,item};}).filter((x:any)=>!words.length||x.score>0).sort((a:any,b:any)=>b.score-a.score).slice(0,limit);
	return {query:input.query||'',results,count:results.length};
}

export async function exportLibrary(workspaceId:string) {
	const state=await readLibrary(workspaceId); return {schema:'orbitfs-library-pack-v2',exportedAt:now(),workspaceId,items:state.items,collections:state.collections,links:state.links.filter((x:any)=>x.origin!=='automatic')};
}

export async function importLibrary(user:OrbitUser,workspaceId:string,pack:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); if(pack?.pack) pack=pack.pack; if(!['orbitfs-library-pack-v1','orbitfs-library-pack-v2'].includes(String(pack?.schema||''))) throw Object.assign(new Error('Unsupported Library pack'),{status:400});
	let importedItems=0,importedCollections=0,importedLinks=0,mappedItems=0; for(const item of pack.items||[]){if(item.source?.provider==='base.files')continue;const r=await createLibraryItem(user,workspaceId,{...item,source:item.source,provider:item.source?.provider});if(!r.existing) importedItems++;mappedItems++;} for(const c of pack.collections||[]){await createCollection(user,workspaceId,c);importedCollections++;} for(const l of pack.links||[]){try{await createLink(user,workspaceId,l);importedLinks++;}catch{}} return {importedItems,importedCollections,importedLinks,mappedItems,errors:[]};
}export async function saveUsage(user:OrbitUser,workspaceId:string,input:any) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const item=state.items.find((x:any)=>x.id===input.itemId); if(!item)throw Object.assign(new Error('Knowledge item not found'),{status:404});
	let usage=state.usage.find((x:any)=>x.itemId===input.itemId&&x.consumerType===input.consumerType&&x.consumerId===input.consumerId); if(!usage){usage={id:uid('use'),workspaceId,itemId:input.itemId,createdAt:now()};state.usage.push(usage);} Object.assign(usage,{sectionId:input.sectionId||null,consumerType:text(input.consumerType,80),consumerId:text(input.consumerId,180),consumerName:text(input.consumerName||input.consumerId,180),metadata:input.metadata||{},updatedAt:now()}); await saveLibrary(workspaceId,state); return {usage};
}
export async function deleteUsage(user:OrbitUser,workspaceId:string,id:string) {
	const ctx=await libraryContext(user,workspaceId); requireManage(ctx.canManage); const state=await readLibrary(workspaceId); const before=state.usage.length; state.usage=state.usage.filter((x:any)=>x.id!==id); if(before===state.usage.length)throw Object.assign(new Error('Usage record not found'),{status:404}); await saveLibrary(workspaceId,state); return {deleted:true,id};
}

function approvalSummary(request:any){return JSON.parse(JSON.stringify(request));}
function recordMarkdown(raw:any){
  const lines=[`\n\n## ${text(raw.title||raw.type||'Record',240)}`];
  if(raw.date)lines.push(`- Date: ${text(raw.date,60)}`);
  if(raw.category)lines.push(`- Category: ${text(raw.category,120)}`);
  if(raw.content)lines.push('',String(raw.content).trim());
  return lines.join('\n')+'\n';
}
function writableLifecycle(item:any){return ['current','draft','unclassified'].includes(String(item?.lifecycleState||item?.lifecycle||'unclassified'));}
function canonicalRoleTarget(state:any,role:string){
  const matches=(state.items||[]).filter((item:any)=>item.status==='active'&&writableLifecycle(item)&&(item.roles||[]).includes(role));
  return matches.length===1?matches[0]:null;
}
async function itemContent(_workspaceId:string,item:any){
  if(['library.native','memory.knowledge'].includes(item.source?.provider))return String(item.content||'');
  throw Object.assign(new Error('Only native Library/Memory knowledge can be an authoritative content target'),{status:409,code:'KNOWLEDGE_TARGET_NOT_WRITABLE'});
}
async function prepareApprovalOperation(user:OrbitUser,workspaceId:string,state:any,raw:any,order:number){
  const operation:any={id:uid('op'),order,type:text(raw.type,80),input:JSON.parse(JSON.stringify(raw||{})),status:'pending'};
  if(operation.type==='profile_record_add'){
    const profileId=text(raw.profileId,160),sectionId=text(raw.sectionId||'records',120);
    if(!profileId){operation.status='needs_target';operation.target={system:'profile',profileId:null,sectionId};return operation;}
    const ctx=await libraryContext(user,workspaceId),projection=await profileKnowledgeProjection(workspaceId,profileId,ctx.role,user.id,user.role),profile=projection.profile;
    const section=(profile.sections||[]).find((x:any)=>String(x.id)===sectionId)||(sectionId==='records'?{id:'records',title:'Records',content:''}:null);
    if(!section)throw Object.assign(new Error('Selected profile section is unavailable'),{status:404,code:'KNOWLEDGE_PROFILE_SECTION_MISSING'});
    operation.target={system:'profile',profileId:profile.id,profileName:profile.name,sectionId:section.id,sectionTitle:section.title||section.id};
    operation.expected={profileVersion:Number(profile.version||0)};operation.after={sectionContent:String(section.content||'')+recordMarkdown(raw)};
    return operation;
  }
  if(operation.type==='profile_record_revision'){
    const profileId=text(raw.profileId,160),sectionId=text(raw.sectionId||'records',120),mode=text(raw.mode||'change',32);
    if(!profileId)throw Object.assign(new Error('Profile target is required'),{status:400});
    const ctx=await libraryContext(user,workspaceId),projection=await profileKnowledgeProjection(workspaceId,profileId,ctx.role,user.id,user.role),profile=projection.profile;
    const section=(profile.sections||[]).find((x:any)=>String(x.id)===sectionId)||(sectionId==='records'?{id:'records',title:'Records',content:''}:null);
    if(!section)throw Object.assign(new Error('Selected profile section is unavailable'),{status:404,code:'KNOWLEDGE_PROFILE_SECTION_MISSING'});
    const current=String(section.content||''),oldBlock=String(raw.oldBlock||''),newBlock=String(raw.newBlock||'');let next=current;
    if(mode==='restore'&&!oldBlock)next=current+newBlock;else{const at=current.lastIndexOf(oldBlock);if(!oldBlock||at<0)throw Object.assign(new Error('The approved record has changed since this revision was prepared'),{status:409,code:'KNOWLEDGE_CHANGE_STALE'});next=current.slice(0,at)+newBlock+current.slice(at+oldBlock.length);}
    operation.target={system:'profile',profileId:profile.id,profileName:profile.name,sectionId:section.id,sectionTitle:section.title||section.id};
    operation.expected={profileVersion:Number(profile.version||0)};operation.after={sectionContent:next,oldBlock,newBlock};return operation;
  }
  if(['append_to_role','append_to_item','knowledge_record_add'].includes(operation.type)){
    const role=text(raw.role,80),item=(raw.itemId?(state.items||[]).find((x:any)=>x.id===String(raw.itemId)):canonicalRoleTarget(state,role));
    if(!item){operation.status='needs_target';operation.target={system:'library',role,itemId:null};return operation;}
    const current=await itemContent(workspaceId,item);operation.target={system:'library',itemId:item.id,itemName:item.name,role,path:item.source?.locator?.path||null,provider:item.source?.provider};
    operation.expected={contentHash:crypto.createHash('sha256').update(current).digest('hex')};operation.after={append:recordMarkdown(raw)};return operation;
  }
  if(operation.type==='timeline_event_add'){
    operation.target={system:'library',itemId:text(raw.itemId,160)||null};operation.after={date:text(raw.date,40),title:text(raw.title,240),description:text(raw.description||raw.content,2000),eventType:text(raw.eventType||'event',80)};return operation;
  }
  if(operation.type==='library_item_update'){
    const item=(state.items||[]).find((x:any)=>x.id===String(raw.itemId));if(!item)throw Object.assign(new Error('Knowledge item not found'),{status:404});
    const patch=raw.patch&&typeof raw.patch==='object'?raw.patch:{};operation.target={system:'library',itemId:item.id,itemName:item.name};operation.expected={updatedAt:item.updatedAt||null};operation.after={fields:patch};return operation;
  }
  throw Object.assign(new Error(`Unsupported change operation: ${operation.type||'missing'}`),{status:400,code:'KNOWLEDGE_CHANGE_OPERATION_INVALID'});
}

export async function createLibraryChangeRequest(user:OrbitUser,workspaceId:string,input:any={}){
  await requireWorkspaceAccess(user,await getWorkspace(workspaceId));const state=await readLibrary(workspaceId),rawOps=Array.isArray(input.operations)?input.operations:[];
  if(!rawOps.length)throw Object.assign(new Error('At least one proposed change is required'),{status:400});
  const operations=[];for(let i=0;i<rawOps.length;i++)operations.push(await prepareApprovalOperation(user,workspaceId,state,rawOps[i],i));
  const request:any={id:uid('cr'),workspaceId,status:operations.some((x:any)=>x.status==='needs_target')?'needs_target':'pending',source:input.source||{system:'unknown'},sourceSnapshot:input.sourceSnapshot||null,summary:text(input.summary||input.source?.title||'Proposed change',500),reason:text(input.reason,1000),operations,requestedBy:user.username,requestedById:String(user.id),submittedAt:now(),reviewedBy:null,reviewedAt:null,appliedAt:null,error:null,audit:[{at:now(),action:'submitted',actor:user.username}]};
  state.changeRequests.push(request);state.changeRequests=state.changeRequests.slice(-5000);await saveLibrary(workspaceId,state);return approvalSummary(request);
}
export async function listLibraryChangeRequests(user:OrbitUser,workspaceId:string,input:any={}){
  const ctx=await libraryContext(user,workspaceId),state=await readLibrary(workspaceId),status=text(input.status,40),sourceSystem=text(input.sourceSystem,80),sourceEntryId=text(input.sourceEntryId,180);
  return {requests:(state.changeRequests||[]).filter((r:any)=>ctx.canManage||String(r.requestedById)===String(user.id)).filter((r:any)=>!status||r.status===status).filter((r:any)=>!sourceSystem||r.source?.system===sourceSystem).filter((r:any)=>!sourceEntryId||String(r.source?.entryId)===sourceEntryId).slice().reverse().map(approvalSummary)};
}

export async function assignLibraryChangeRequestTargets(user:OrbitUser,workspaceId:string,requestId:string,input:any={}){
  const ctx=await libraryContext(user,workspaceId);requireManage(ctx.canManage);const state=await readLibrary(workspaceId),request=(state.changeRequests||[]).find((r:any)=>r.id===requestId);
  if(!request)throw Object.assign(new Error('Change request not found'),{status:404});if(!['needs_target','pending'].includes(request.status))throw Object.assign(new Error('Change request target can no longer be changed'),{status:409});
  const targets=input.targets&&typeof input.targets==='object'?input.targets:{},operations=[];
  for(const operation of request.operations||[]){const selected=targets[operation.id]??targets[String(operation.order)]??input.itemId;if(selected===undefined||selected===null||selected===''){operations.push(operation);continue;}
    const next={...operation.input,type:operation.type};if(operation.type==='profile_record_add'){const target=typeof selected==='object'?selected:{profileId:selected};next.profileId=target.profileId||operation.target?.profileId;next.sectionId=target.sectionId||operation.target?.sectionId||'records';}else next.itemId=typeof selected==='object'?selected.itemId:selected;
    const rebuilt=await prepareApprovalOperation(user,workspaceId,state,next,operation.order);rebuilt.id=operation.id;operations.push(rebuilt);
  }
  request.operations=operations;request.status=operations.some((x:any)=>x.status==='needs_target')?'needs_target':'pending';request.audit.push({at:now(),action:'targets_assigned',actor:user.username});await saveLibrary(workspaceId,state);return approvalSummary(request);
}
async function applyApprovalOperation(user:OrbitUser,workspaceId:string,operation:any){
  if(operation.status==='needs_target')throw Object.assign(new Error('A target must be selected before approval'),{status:409,code:'KNOWLEDGE_TARGET_REQUIRED'});
  if(['append_to_role','append_to_item','knowledge_record_add'].includes(operation.type)){
    const state=await readLibrary(workspaceId),item=(state.items||[]).find((x:any)=>x.id===operation.target?.itemId);if(!item)throw Object.assign(new Error('Knowledge target not found'),{status:404});
    const current=await itemContent(workspaceId,item),currentHash=crypto.createHash('sha256').update(current).digest('hex');if(currentHash!==operation.expected?.contentHash)throw Object.assign(new Error('Target changed after submission; resubmit against the latest version'),{status:409,code:'KNOWLEDGE_CHANGE_STALE'});
    const next=current+String(operation.after?.append||'');
    if(!['library.native','memory.knowledge'].includes(item.source?.provider))throw Object.assign(new Error('The selected target is legacy/read-only. Choose native Library/Memory knowledge.'),{status:409,code:'KNOWLEDGE_TARGET_NOT_WRITABLE'});
    await updateLibraryItem(user,workspaceId,item.id,{content:next});return {itemId:item.id,provider:item.source.provider};
  }
  if(operation.type==='profile_record_add'){
    const ctx=await libraryContext(user,workspaceId),projection=await profileKnowledgeProjection(workspaceId,operation.target.profileId,ctx.role,user.id,user.role),profile=projection.profile;
    if(Number(profile.version||0)!==Number(operation.expected?.profileVersion))throw Object.assign(new Error('Profile changed after submission; resubmit against the latest version'),{status:409,code:'KNOWLEDGE_CHANGE_STALE'});
    const sectionId=String(operation.target.sectionId||'records'),sections=[...(profile.sections||[])],index=sections.findIndex((x:any)=>String(x.id)===sectionId),base=index>=0?{...sections[index]}:{id:sectionId,title:sectionId==='records'?'Records':sectionId,kind:'text',content:''};base.content=String(operation.after?.sectionContent||'');if(index>=0)sections[index]=base;else sections.push(base);
    const updated=await updateProfile(workspaceId,profile.id,{sections},user.username,ctx.role,user.id);return {profileId:updated.id,sectionId,version:updated.version};
  }
  if(operation.type==='profile_record_revision'){
    const ctx=await libraryContext(user,workspaceId),projection=await profileKnowledgeProjection(workspaceId,operation.target.profileId,ctx.role,user.id,user.role),profile=projection.profile;
    if(Number(profile.version||0)!==Number(operation.expected?.profileVersion))throw Object.assign(new Error('Profile changed after submission; resubmit against the latest version'),{status:409,code:'KNOWLEDGE_CHANGE_STALE'});
    const sectionId=String(operation.target.sectionId||'records'),sections=[...(profile.sections||[])],index=sections.findIndex((x:any)=>String(x.id)===sectionId),base=index>=0?{...sections[index]}:{id:sectionId,title:sectionId==='records'?'Records':sectionId,kind:'text',content:''};
    base.content=String(operation.after?.sectionContent||'');if(index>=0)sections[index]=base;else sections.push(base);
    const updated=await updateProfile(workspaceId,profile.id,{sections},user.username,ctx.role,user.id);return {profileId:updated.id,sectionId,version:updated.version,mode:operation.input?.mode||'change'};
  }
  if(operation.type==='timeline_event_add')return createEvent(user,workspaceId,{itemId:operation.target?.itemId,...operation.after});
  if(operation.type==='library_item_update')return updateLibraryItem(user,workspaceId,operation.target.itemId,operation.after?.fields||{});
  throw Object.assign(new Error('Unsupported change operation'),{status:400});
}

export async function resolveLibraryChangeRequest(user:OrbitUser,workspaceId:string,requestId:string,input:any={}){
  const ctx=await libraryContext(user,workspaceId);requireManage(ctx.canManage);let state=await readLibrary(workspaceId),request=(state.changeRequests||[]).find((r:any)=>r.id===requestId);
  if(!request)throw Object.assign(new Error('Change request not found'),{status:404});if(!['pending','needs_target'].includes(request.status))throw Object.assign(new Error('Change request is no longer pending'),{status:409});
  const approve=input.approved===true||input.status==='approved',note=text(input.note,1000);if(approve&&request.status==='needs_target')throw Object.assign(new Error('Select a valid target before approving this request'),{status:409,code:'KNOWLEDGE_TARGET_REQUIRED'});if(!approve&&!note)throw Object.assign(new Error('A reason is required when denying a request'),{status:400,code:'KNOWLEDGE_REVIEW_REASON_REQUIRED'});
  request.status=approve?'applying':'denied';request.reviewNote=note;request.reviewedBy=user.username;request.reviewedById=String(user.id);request.reviewedAt=now();request.audit.push({at:now(),action:approve?'approved':'denied',actor:user.username,note});await saveLibrary(workspaceId,state);
  if(!approve)return approvalSummary(request);
  try{
    const results=[];for(const operation of request.operations||[])results.push({operationId:operation.id,result:await applyApprovalOperation(user,workspaceId,operation)});
    state=await readLibrary(workspaceId);request=(state.changeRequests||[]).find((r:any)=>r.id===requestId);request.status='applied';request.appliedAt=now();request.results=results;request.audit.push({at:now(),action:'applied',actor:user.username});await saveLibrary(workspaceId,state);return approvalSummary(request);
  }catch(error:any){state=await readLibrary(workspaceId);request=(state.changeRequests||[]).find((r:any)=>r.id===requestId);request.status=error?.code==='KNOWLEDGE_CHANGE_STALE'?'stale':'failed';request.error=error?.message||String(error);request.audit.push({at:now(),action:request.status,actor:user.username,error:request.error});await saveLibrary(workspaceId,state);throw error;}
}

export async function createLibraryGroup(user:OrbitUser,workspaceId:string,input:any={}){
  const ctx=await libraryContext(user,workspaceId);requireManage(ctx.canManage);const state=await readLibrary(workspaceId),name=text(input.name,120);
  if(!name)throw Object.assign(new Error('Group name is required'),{status:400});if((state.groups||[]).some((g:any)=>String(g.name||'').toLowerCase()===name.toLowerCase()))throw Object.assign(new Error('A Knowledge group with that name already exists'),{status:409});
  const group={id:uid('kgrp'),name,description:text(input.description,500),createdAt:now(),updatedAt:now()};state.groups.push(group);await saveLibrary(workspaceId,state);return {group};
}
export async function updateLibraryGroup(user:OrbitUser,workspaceId:string,groupId:string,input:any={}){
  const ctx=await libraryContext(user,workspaceId);requireManage(ctx.canManage);const state=await readLibrary(workspaceId),group=(state.groups||[]).find((g:any)=>g.id===groupId);if(!group)throw Object.assign(new Error('Knowledge group not found'),{status:404});
  if(input.name!==undefined){const name=text(input.name,120);if(!name)throw Object.assign(new Error('Group name is required'),{status:400});group.name=name;}if(input.description!==undefined)group.description=text(input.description,500);group.updatedAt=now();await saveLibrary(workspaceId,state);return {group};
}
export async function deleteLibraryGroup(user:OrbitUser,workspaceId:string,groupId:string){
  const ctx=await libraryContext(user,workspaceId);requireManage(ctx.canManage);const state=await readLibrary(workspaceId);if(!(state.groups||[]).some((g:any)=>g.id===groupId))throw Object.assign(new Error('Knowledge group not found'),{status:404});state.groups=(state.groups||[]).filter((g:any)=>g.id!==groupId);for(const item of state.items||[])if(item.groupId===groupId)item.groupId=null;await saveLibrary(workspaceId,state);return {deleted:true,groupId};
}
export async function resolveLibraryRoleTargets(user:OrbitUser,workspaceId:string,role:string){
  await requireWorkspaceAccess(user,await getWorkspace(workspaceId));const cleanRole=text(role,64).toLowerCase();if(!roleIds.has(cleanRole))throw Object.assign(new Error('Unknown Library role'),{status:400});const visible=await presentLibrary(user,workspaceId);
  const targets=(visible.items||[]).filter((item:any)=>item.status==='active'&&['library.native','memory.knowledge','base.profiles'].includes(item.source?.provider)&&writableLifecycle({...item,lifecycleState:item.effectiveLifecycleState||item.lifecycleState})&&(item.roles||[]).includes(cleanRole)).sort((a:any,b:any)=>Number((b.lifecycleState||b.lifecycle)==='current')-Number((a.lifecycleState||a.lifecycle)==='current')||Number(b.currentTarget===true)-Number(a.currentTarget===true)||Number(b.targetPriority||50)-Number(a.targetPriority||50)||String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
  const currentCount=targets.filter((item:any)=>(item.effectiveLifecycleState||item.lifecycleState||item.lifecycle)==='current').length;return {role:cleanRole,definition:LIBRARY_ROLES.find((x)=>x.id===cleanRole),recommended:targets[0]||null,targets,currentCount,ambiguousCurrent:currentCount>1};
}
export async function libraryHealth(user:OrbitUser,workspaceId:string){
  await requireWorkspaceAccess(user,await getWorkspace(workspaceId));const state=await readLibrary(workspaceId),visible=await presentLibrary(user,workspaceId),issues:any[]=[];
  for(const item of visible.items||[]){
    if(item.source?.provider==='base.files')issues.push({severity:'info',code:'LEGACY_FILE_SOURCE',itemId:item.id,itemName:item.name,message:'Legacy file-backed Knowledge is compatibility-only and cannot receive authoritative writes.'});
    const invalid=(item.roles||[]).filter((roleId:string)=>{const def=LIBRARY_ROLES.find((r)=>r.id===roleId);return !def||(def.sourceKinds?.length&&!def.sourceKinds.includes(item.kind));});if(invalid.length)issues.push({severity:'warning',code:'INVALID_ROLE_KIND',itemId:item.id,itemName:item.name,roles:invalid,message:'One or more Library roles do not match this source type.'});
    if(item.currentTarget&&!(item.roles||[]).some((r:string)=>!['core_knowledge','core_profile'].includes(r)))issues.push({severity:'info',code:'PREFERRED_WITHOUT_TARGET_ROLE',itemId:item.id,itemName:item.name,message:'Preferred/current target is set but this item has no destination role.'});
    if(item.kind==='knowledge'&&!item.sourceTracking&&!['archived','deprecated'].includes(item.effectiveLifecycleState||item.lifecycleState||item.lifecycle))issues.push({severity:'info',code:'NOT_INDEXED',itemId:item.id,itemName:item.name,message:'Knowledge source has not been indexed yet.'});
  }
  for(const role of LIBRARY_ROLES.filter((r)=>!['core_knowledge','core_profile'].includes(r.id))){const current=(visible.items||[]).filter((item:any)=>item.status==='active'&&(item.roles||[]).includes(role.id)&&(item.effectiveLifecycleState||item.lifecycleState||item.lifecycle)==='current');if(current.length>1)issues.push({severity:'warning',code:'MULTIPLE_CURRENT_TARGETS',role:role.id,itemIds:current.map((x:any)=>x.id),message:`${current.length} Current targets are assigned to ${role.label}.`});}
  return {healthy:!issues.some((x)=>x.severity==='error'),issueCount:issues.length,issues,checkedItems:(visible.items||[]).length,updatedAt:state.updatedAt||null};
}

export async function editLibraryChangeRequestOperation(user:OrbitUser,workspaceId:string,requestId:string,input:any={}){
  const ctx=await libraryContext(user,workspaceId);requireManage(ctx.canManage);const state=await readLibrary(workspaceId),request=(state.changeRequests||[]).find((r:any)=>r.id===requestId);
  if(!request)throw Object.assign(new Error('Change request not found'),{status:404});if(!['needs_target','pending'].includes(request.status))throw Object.assign(new Error('Change request can no longer be edited'),{status:409});
  const operationId=String(input.operationId||''),operation=(request.operations||[]).find((x:any)=>x.id===operationId);if(!operation)throw Object.assign(new Error('Change operation not found'),{status:404});
  const patch=input.patch&&typeof input.patch==='object'?input.patch:{},safe=Object.fromEntries(Object.entries(patch).filter(([key])=>['title','content','date','category'].includes(key)));
  const next={...operation.input,...safe,type:operation.type};if(operation.target?.itemId)next.itemId=operation.target.itemId;if(operation.target?.profileId){next.profileId=operation.target.profileId;next.sectionId=operation.target.sectionId||next.sectionId;}
  const rebuilt=await prepareApprovalOperation(user,workspaceId,state,next,operation.order);rebuilt.id=operation.id;request.operations=(request.operations||[]).map((x:any)=>x.id===operation.id?rebuilt:x);request.status=request.operations.some((x:any)=>x.status==='needs_target')?'needs_target':'pending';request.audit.push({at:now(),action:'proposal_edited',actor:user.username,operationId:operation.id,fields:Object.keys(safe)});await saveLibrary(workspaceId,state);return approvalSummary(request);
}

export async function createAppliedChangeRevision(user:OrbitUser,workspaceId:string,requestId:string,input:any={}){
  const ctx=await libraryContext(user,workspaceId);requireManage(ctx.canManage);const action=String(input.action||'change').toLowerCase();if(!['change','remove','restore'].includes(action))throw Object.assign(new Error('Revision action must be change, remove or restore'),{status:400});
  const state=await readLibrary(workspaceId),parent=(state.changeRequests||[]).find((r:any)=>r.id===requestId);if(!parent||parent.status!=='applied')throw Object.assign(new Error('Only applied approvals can be revised'),{status:409});
  const sourceOp=(parent.operations||[]).find((x:any)=>!input.operationId||String(x.id)===String(input.operationId));if(!sourceOp)throw Object.assign(new Error('Applied operation not found'),{status:404});if(!['profile_record_add','profile_record_revision'].includes(sourceOp.type))throw Object.assign(new Error('Post-approval revision is currently supported for Profile Records'),{status:409,code:'KNOWLEDGE_REVISION_UNSUPPORTED'});
  const previousData={...(sourceOp.input?.recordData||sourceOp.input||{})},patch=input.patch&&typeof input.patch==='object'?input.patch:{},recordData={...previousData,...Object.fromEntries(Object.entries(patch).filter(([key])=>['title','content','date','category'].includes(key)))};
  let currentBlock=sourceOp.type==='profile_record_add'?recordMarkdown(sourceOp.input||{}):String(sourceOp.after?.newBlock??sourceOp.input?.newBlock??''),nextBlock='';
  if(action==='change'){if(!currentBlock)throw Object.assign(new Error('Removed records must be restored before changing them'),{status:409});nextBlock=recordMarkdown(recordData);}else if(action==='remove'){if(!currentBlock)throw Object.assign(new Error('This record is already removed'),{status:409});nextBlock='';}else{if(sourceOp.type!=='profile_record_revision')throw Object.assign(new Error('Nothing to restore on the original applied record'),{status:409});nextBlock=String(sourceOp.after?.oldBlock??sourceOp.input?.oldBlock??'');}
  const raw={type:'profile_record_revision',mode:action,profileId:sourceOp.target?.profileId||sourceOp.input?.profileId,sectionId:sourceOp.target?.sectionId||sourceOp.input?.sectionId||'records',oldBlock:currentBlock,newBlock:nextBlock,recordData,previousRecordData:previousData,rootRequestId:sourceOp.input?.rootRequestId||parent.id,rootOperationId:sourceOp.input?.rootOperationId||sourceOp.id};
  return createLibraryChangeRequest(user,workspaceId,{source:{system:'library_revision',parentRequestId:parent.id,title:recordData.title||parent.summary},sourceSnapshot:{parentRequestId:parent.id,action},summary:`${action==='change'?'Revise':action==='remove'?'Remove':'Restore'} approved record: ${recordData.title||parent.summary}`,reason:text(input.reason,1000),operations:[raw]});
}
