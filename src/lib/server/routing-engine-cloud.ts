// Cloud-native port of the live OrbitFS deterministic routing engine.
// It only produces suggestions; mutations remain approval-gated in Library.
import type { OrbitUser } from '$lib/server/auth';
import { getWorkspace, requireWorkspaceAccess } from '$lib/server/workspaces';
import { profileCatalog } from '$lib/server/workspace-profiles.js';
import { readLibrary } from '$lib/server/library';
import { resolveKnowledgeRoute } from '$lib/server/knowledge-architecture';

const norm=(v:any)=>String(v??'').trim();
const lower=(v:any)=>norm(v).toLowerCase();
const uniq=(items:any[])=>[...new Set((items||[]).filter(Boolean))];
const clamp=(n:any)=>Math.max(0,Math.min(1,Number(n)||0));
const words=(v:any)=>uniq(lower(v).replace(/[^a-z0-9\s-]+/g,' ').split(/\s+/).filter((x:string)=>x.length>2));
const textOf=(entry:any={})=>`${entry.title||''}\n${entry.content||entry.content_text||''}\n${entry.summary||''}`.toLowerCase();

const TYPE_ROUTES:any={
  'profile-record':{kind:'profile_record_add',sectionId:'records',confidence:.98,label:'Profile Record'},
  'profile_record':{kind:'profile_record_add',sectionId:'records',confidence:.98,label:'Profile Record'},
  profile:{kind:'profile_record_add',sectionId:'records',confidence:.96,label:'Profile Record'},
  incident:{kind:'knowledge_record_add',role:'incident_log',confidence:.97,label:'Incident'},
  timeline:{kind:'knowledge_record_add',role:'timeline',confidence:.97,label:'Timeline'},
  evidence:{kind:'knowledge_record_add',role:'evidence_target',confidence:.96,label:'Evidence'},
  reference:{kind:'knowledge_record_add',role:'reference_target',confidence:.95,label:'Reference'},
  research:{kind:'knowledge_record_add',role:'reference_target',confidence:.89,label:'Research / Reference'},
  statement:{kind:'knowledge_record_add',role:'general_record_target',confidence:.90,label:'Statement / Document'},
  report:{kind:'knowledge_record_add',role:'general_record_target',confidence:.90,label:'Report / Document'},
  letter:{kind:'knowledge_record_add',role:'general_record_target',confidence:.88,label:'Letter / Document'},
  document:{kind:'knowledge_record_add',role:'general_record_target',confidence:.84,label:'Document'},
  note:{kind:'knowledge_record_add',role:'general_record_target',confidence:.68,label:'Note / General record'}
};

function matchingProfiles(entry:any,profiles:any[]){
  const body=textOf(entry),explicit=uniq([entry.profileTargetId,...(entry.profileIds||[])]);
  const exact=new Map(profiles.map((p:any)=>[String(p.id),p])),out:any[]=[];
  for(const id of explicit){const p:any=exact.get(String(id));if(p)out.push({profileId:String(p.id),profileName:p.name,score:1,reason:'Explicit profile target/reference'});}
  for(const p of profiles){if(out.some(x=>x.profileId===String(p.id)))continue;const names=uniq([p.name,...(Array.isArray(p.nicknames)?p.nicknames:[])]).map(lower).filter((x:string)=>x.length>2);if(names.some((name:string)=>body.includes(name)))out.push({profileId:String(p.id),profileName:p.name,score:.76,reason:`Content mentions ${p.name}`});}
  return out.sort((a,b)=>b.score-a.score).slice(0,8);
}
function profileSectionFor(entry:any){
  if(entry.profileSectionId&&entry.profileSectionId!=='records')return entry.profileSectionId;
  const body=textOf(entry);
  if(/date of birth|\bdob\b|born on|location:|lives in|moved to|nickname/.test(body))return 'core-information';
  if(/relationship|daughter|father|mother|partner|friend|ex[- ]?(partner|girlfriend|boyfriend)/.test(body))return 'relationships';
  if(/background|who (he|she|they|i) (is|was)|grew up|childhood|work history/.test(body))return 'background';
  if(/history|previously|in the past|used to|long[- ]term/.test(body))return 'history';
  if(/reference|source|citation|document link/.test(body))return 'references';
  if(/private note|confidential note|do not share/.test(body))return 'private-notes';
  return 'records';
}
function overlapScore(a:any,b:any){const A=new Set(words(a)),B=new Set(words(b));if(!A.size||!B.size)return 0;let hits=0;for(const token of A)if(B.has(token))hits++;return hits/Math.max(3,Math.min(A.size,B.size));}
function existingMatch(suggestion:any,entry:any,state:any){
  const body=textOf(entry),date=String(entry.date||entry.entryDate||entry.entry_date||'').slice(0,10);
  const pool=suggestion.role==='timeline'?(state.events||[]):(state.records||[]);
  let best:any=null;
  for(const row of pool){const hay=`${row.title||''}\n${row.summary||row.description||''}\n${row.notes||''}`;let score=overlapScore(body,hay);if(date&&String(row.date||'').slice(0,10)===date)score+=.22;if(score>Number(best?.score||0))best={score:clamp(score),id:row.id,title:row.title||null,date:row.date||null,itemId:row.itemId||null,sectionId:row.sectionId||null};}
  return best&&best.score>=.38?best:null;
}
function contentCandidates(entry:any){
  const body=textOf(entry),out:any[]=[];const has=(v:string[])=>v.some(word=>body.includes(word));
  if(has(['incident','happened','occurred','police','arrest','breach','argument','assault','threat','welfare check','court event']))out.push({kind:'knowledge_record_add',role:'incident_log',label:'Incident',confidence:.69,reason:'Content contains incident/event language'});
  if(has(['timeline','yesterday','today','last night','then ','after that','before that','next date','on the ']))out.push({kind:'knowledge_record_add',role:'timeline',label:'Timeline event',confidence:.59,reason:'Content contains chronological/event language'});
  if(has(['evidence','exhibit','screenshot','photo','recording','email from','message from','document shows','attachment']))out.push({kind:'knowledge_record_add',role:'evidence_target',label:'Evidence',confidence:.64,reason:'Content references evidence/source material'});
  if(has(['reference','research','source:','citation','background information','article','website']))out.push({kind:'knowledge_record_add',role:'reference_target',label:'Reference',confidence:.58,reason:'Content appears reference/research oriented'});
  if(has(['statement','report','letter','document','submission','application','affidavit']))out.push({kind:'knowledge_record_add',role:'general_record_target',label:'Document / statement',confidence:.61,reason:'Content reads like a reusable document or statement'});
  return out;
}
function dedupe(items:any[]){const seen=new Map();for(const item of items){const key=[item.kind,item.role||'',item.profileId||'',item.sectionId||'',item.itemId||''].join('|');const cur=seen.get(key);if(!cur||Number(item.confidence)>Number(cur.confidence))seen.set(key,{...item,confidence:clamp(item.confidence)});}return [...seen.values()].sort((a:any,b:any)=>b.confidence-a.confidence).slice(0,20);}

export async function analyzeCloudRouting(user:OrbitUser,workspaceId:string,entry:any,settings:any={}){
  const workspace=await getWorkspace(workspaceId);const role=await requireWorkspaceAccess(user,workspace);
  const allowKnowledge=settings.allowKnowledge!==false&&settings.knowledgeArchitecture!==false;
  const allowProfiles=settings.allowProfiles!==false&&settings.profiles!==false;
  const allowProjects=settings.allowProjects!==false&&settings.projects!==false;
  const [catalog,state]=await Promise.all([allowProfiles?profileCatalog(workspaceId,role,user.id,user.role):Promise.resolve({profiles:[]}),readLibrary(workspaceId)]);
  const profiles=catalog.profiles||[],subtype=lower(entry.type||entry.subtype||entry.recordType||entry.metadata?.recordType||'general');
  const maxChars=Math.max(1000,Math.min(200000,Number(settings.maxCharacters||50000)));
  const safeEntry={...entry,content:String(entry.content||entry.content_text||'').slice(0,maxChars),profileTargetId:entry.profileTargetId||entry.metadata?.profileTargetId,profileSectionId:entry.profileSectionId||entry.metadata?.profileSectionId};
  const profileMatches=allowProfiles?matchingProfiles(safeEntry,profiles):[],suggestions:any[]=[];
  const explicit=TYPE_ROUTES[subtype];
  if(explicit?.kind==='profile_record_add'){
    if(allowProfiles){const target=profileMatches.find((p:any)=>p.score===1)||profileMatches[0]||null;suggestions.push({...explicit,profileId:target?.profileId||safeEntry.profileTargetId||null,profileName:target?.profileName||null,sectionId:profileSectionFor(safeEntry),action:'append',reason:target?'Entry type and profile target identify a profile update':'Entry type identifies a profile update; destination profile still needs review'});}
  } else if(explicit&&allowKnowledge)suggestions.push({...explicit,action:'create',reason:`Entry type is ${explicit.label}`});
  else if(allowKnowledge)suggestions.push({kind:'knowledge_record_add',role:'general_record_target',label:'General record',confidence:.55,action:'create',reason:'No explicit specialized entry type is selected'});
  if(allowKnowledge&&['general','note','document','mental-health','statement','report','letter'].includes(subtype))suggestions.push(...contentCandidates(safeEntry));
  if(allowProfiles&&!explicit?.kind?.startsWith('profile')&&profileMatches.length){for(const p of profileMatches.slice(0,3))suggestions.push({kind:'profile_record_add',profileId:p.profileId,profileName:p.profileName,sectionId:profileSectionFor(safeEntry),label:`Profile update -> ${p.profileName}`,confidence:clamp(p.score*.84),action:'append',reason:`${p.reason}; content best fits profile section ${profileSectionFor(safeEntry)}`});}
  if(allowKnowledge&&entry.metadata?.libraryItemId)suggestions.push({kind:'library_item_update',itemId:String(entry.metadata.libraryItemId),label:'Update linked Library document',confidence:.99,action:'update',reason:'Entry is explicitly linked to an existing Library item'});
  const architectureRoute=allowKnowledge?await resolveKnowledgeRoute(workspaceId,{projectId:allowProjects?entry.metadata?.projectId:undefined,projectName:allowProjects?entry.metadata?.projectName:undefined,category:entry.category||entry.metadata?.category,name:entry.title,content:safeEntry.content}):{matched:false,routing:'never',scope:'workspace',category:null,destinationId:null,destinationLabel:null,destinationType:null,confidence:0};
  if(allowKnowledge&&architectureRoute.matched&&architectureRoute.routing!=='never'){
    const exact=architectureRoute.destinationType==='knowledge';
    suggestions.push({kind:'knowledge_record_add',role:'general_record_target',itemId:exact?architectureRoute.destinationId:null,label:`Knowledge Setup → ${architectureRoute.destinationLabel}`,confidence:clamp(Number(architectureRoute.confidence||.7)),action:exact?'create':'review',architectureRoute,reason:`Knowledge Setup matched ${architectureRoute.scope} route ${architectureRoute.category} → ${architectureRoute.destinationLabel}`});
  }
  const enriched=suggestions.map((item:any)=>{if(item.kind!=='knowledge_record_add')return item;const match=existingMatch(item,safeEntry,state);return match?{...item,action:'update_candidate',existing:match,confidence:clamp(Math.max(item.confidence,match.score+.18)),reason:`${item.reason}. Similar existing record found: ${match.title||match.id}`}:item;});
  const min=clamp(settings.minConfidence??.55),profileMin=clamp(settings.profileConfidence??min),incidentMin=clamp(settings.incidentConfidence??min),timelineMin=clamp(settings.timelineConfidence??min),max=Math.max(1,Math.min(20,Number(settings.maxSuggestions||8)));
  const threshold=(x:any)=>x.kind==='profile_record_add'?profileMin:x.role==='incident_log'?incidentMin:x.role==='timeline'?timelineMin:min;
  return {processor:'orbitfs-base-routing-v3-cloud',provider:'deterministic',semanticProvider:null,semanticProviderStatus:'not_configured',matcherType:'deterministic',mode:'serverless',filesystem:false,approvalRequired:true,entryType:subtype,profileMatches,knowledgeArchitectureRoute:architectureRoute,suggestions:dedupe(enriched).filter((x:any)=>Number(x.confidence)>=threshold(x)).slice(0,max),libraryContextSummary:{records:(state.records||[]).length,events:(state.events||[]).length},settings:{minConfidence:min,profileConfidence:profileMin,incidentConfidence:incidentMin,timelineConfidence:timelineMin,maxSuggestions:max,maxCharacters:maxChars,allowKnowledge,allowProfiles,allowProjects}};
}