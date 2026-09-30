import type { OrbitUser } from '$lib/server/auth';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { getWorkspace, isSystemAdmin, requireWorkspaceAccess, requireWorkspacePermission, workspaceRole } from '$lib/server/workspaces';

const SCHEMA = 3;
const SETTING_KEY = 'knowledge_architecture';
const text = (value: unknown) => String(value ?? '').trim();
const now = () => new Date().toISOString();
const nativeProvider = (provider: unknown) => ['library.native','memory.knowledge','base.profiles'].includes(text(provider));
const stateWeight:Record<string,number>={active:50,final:45,draft:25,superseded:10,archive:0};
const usageWeight:Record<string,number>={primary:20,reference:5};

function tokenise(value: unknown) {
	return [...new Set(text(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').split(/\s+/).filter((part) => part.length > 2))];
}
function clampPriority(value:unknown){
	const n=Number(value);
	return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):50;
}
function normalizeItem(raw:any={}){
	const itemId=text(raw.itemId||raw.libraryItemId||raw.knowledgeItemId);
	if(!itemId)return null;
	const projectId=text(raw.projectId)||null;
	const state=['active','final','draft','superseded','archive'].includes(String(raw.state))?String(raw.state):'active';
	const usage=['primary','reference'].includes(String(raw.usage))?String(raw.usage):(['requested','search'].includes(String(raw.role))?'reference':'primary');
	const scope=['workspace','project','shared'].includes(String(raw.scope))?String(raw.scope):(projectId?'project':'workspace');
	return {
		id:text(raw.id)||`${projectId?'project':'workspace'}:${itemId}`,		itemId,
		name:text(raw.name)||'Knowledge item',
		kind:text(raw.kind)||'knowledge',
		category:text(raw.category||raw.group),
		provider:text(raw.provider),
		projectId,
		usage,
		state,
		protection:['editable','permission','locked'].includes(String(raw.protection))?String(raw.protection):'permission',
		scope,
		priority:clampPriority(raw.priority ?? (raw.role==='load-first'?100:raw.role==='always'?90:raw.role==='active'?80:50))
	};
}
function normalizeRoute(raw:any={}){
	const destinationType=['category','collection','knowledge'].includes(String(raw.destinationType))?String(raw.destinationType):'category';
	const destinationId=text(raw.destinationId||raw.destination);
	const destinationLabel=text(raw.destinationLabel||raw.destinationName||raw.destination||destinationId);
	const label=text(raw.label||raw.category);
	if(!label||(!destinationId&&!destinationLabel))return null;
	return {
		id:text(raw.id)||`route:${destinationType}:${destinationId||destinationLabel}`,
		label,
		destinationType,
		destinationId:destinationId||destinationLabel,
		destinationLabel:destinationLabel||destinationId,
		routing:['automatic','suggest','manual','never'].includes(String(raw.routing))?String(raw.routing):'suggest'
	};
}function normalizeProject(raw:any={}){
	const name=text(raw.name);
	if(!name)return null;
	return {
		id:text(raw.id)||`project:${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`,
		name,
		description:text(raw.description),
		scope:['project','shared'].includes(String(raw.scope))?String(raw.scope):'project',
		routes:(Array.isArray(raw.routes)?raw.routes:[]).map(normalizeRoute).filter(Boolean)
	};
}
function blank(workspaceId:string,legacyDetected=false){
	return {schema:SCHEMA,workspaceId,revision:0,setupComplete:false,loadingOwnedBy:'MCP OSS/CCS',globalItems:[],projectItems:[],projects:[],globalRoutes:[],createdAt:null,updatedAt:null,updatedBy:null,legacyDetected};
}
function itemScore(item:any){
	return Number(stateWeight[item.state]||0)+Number(usageWeight[item.usage]||0)+Number(item.priority||0)/10+(item.protection==='locked'?1:0);
}
async function librarySnapshot(workspaceId:string){
	const db=getSupabaseAdmin();
	const result=await db.from('orbitfs_library_state').select('state').eq('workspace_id',workspaceId).maybeSingle();
	if(result.error)throw result.error;
	const state:any=result.data?.state||{};
	return {items:Array.isArray(state.items)?state.items:[],collections:Array.isArray(state.collections)?state.collections:[],categories:Array.isArray(state.categories)?state.categories:[]};
}
function migrateStored(workspaceId:string,value:any){
	if(!value||typeof value!=='object')return blank(workspaceId);
	const sourceItems=[...(value.globalItems||[]),...(value.projectItems||[])];
	const projects=(value.projects||[]).map(normalizeProject).filter(Boolean);	const projectIds=new Set(projects.map((p:any)=>p.id));
	const items=sourceItems.map(normalizeItem).filter(Boolean).filter((i:any)=>!i.projectId||projectIds.has(i.projectId));
	return {
		...blank(workspaceId,Number(value.schema||0)!==SCHEMA),
		...value,
		schema:SCHEMA,
		workspaceId,
		loadingOwnedBy:'MCP OSS/CCS',
		globalItems:items.filter((i:any)=>!i.projectId),
		projectItems:items.filter((i:any)=>i.projectId),
		projects,
		globalRoutes:(value.globalRoutes||[]).map(normalizeRoute).filter(Boolean)
	};
}
export function normalizeKnowledgeArchitecture(workspaceId:string,raw:any={},previous:any=null,actor:string|null=null){
	const items=(Array.isArray(raw.items)?raw.items:[...(raw.globalItems||[]),...(raw.projectItems||[])]).map(normalizeItem).filter(Boolean);
	const projects=(Array.isArray(raw.projects)?raw.projects:[]).map(normalizeProject).filter(Boolean);
	const projectIds=new Set(projects.map((project:any)=>project.id));
	const filtered=items.filter((item:any)=>!item.projectId||projectIds.has(item.projectId));
	return {
		schema:SCHEMA,workspaceId,revision:Math.max(1,Number(previous?.revision||0)+1),
		createdAt:previous?.createdAt||now(),updatedAt:now(),updatedBy:actor||previous?.updatedBy||null,
		setupComplete:raw.setupComplete!==false,loadingOwnedBy:'MCP OSS/CCS',
		globalItems:filtered.filter((item:any)=>!item.projectId),
		projectItems:filtered.filter((item:any)=>item.projectId),
		projects,
		globalRoutes:(Array.isArray(raw.globalRoutes)?raw.globalRoutes:[]).map(normalizeRoute).filter(Boolean)
	};}
export async function getKnowledgeArchitecture(workspaceId:string){
	const db=getSupabaseAdmin();
	const result=await db.from('orbitfs_settings').select('value').eq('scope_type','workspace').eq('scope_id',workspaceId).eq('key',SETTING_KEY).maybeSingle();
	if(result.error)throw result.error;
	return migrateStored(workspaceId,result.data?.value);
}
export async function saveKnowledgeArchitecture(user:OrbitUser,workspaceId:string,raw:any={}){
	const workspace=await getWorkspace(workspaceId);
	await requireWorkspaceAccess(user,workspace);
	const role=await workspaceRole(user,workspace);
	if(!isSystemAdmin(user)&&role!=='owner'){
		let allowed=false;
		for(const permission of ['edit_settings','manage_library']){
			try{await requireWorkspacePermission(user,workspace,permission);allowed=true;break;}catch{}
		}
		if(!allowed)throw Object.assign(new Error('Workspace Owner/Admin or workspace setup permission required'),{status:403});
	}
	const previous=await getKnowledgeArchitecture(workspaceId);
	const library=await librarySnapshot(workspaceId);
	const available=new Map<string,any>(library.items.filter((item:any)=>item.status==='active'&&nativeProvider(item.source?.provider)).map((item:any)=>[String(item.id),item]));
	const normalized=normalizeKnowledgeArchitecture(workspaceId,raw,previous,user.username||user.id);
	const hydrate=(entry:any)=>{
		const item=available.get(String(entry.itemId));
		if(!item)return null;
		return {...entry,name:item.name,kind:item.kind,category:entry.category||item.category||'',provider:item.source?.provider||''};
	};
	const architecture={...normalized,globalItems:normalized.globalItems.map(hydrate).filter(Boolean),projectItems:normalized.projectItems.map(hydrate).filter(Boolean)};	const db=getSupabaseAdmin();
	const saved=await db.from('orbitfs_settings').upsert({scope_type:'workspace',scope_id:workspaceId,key:SETTING_KEY,value:architecture,updated_at:now()},{onConflict:'scope_type,scope_id,key'});
	if(saved.error)throw saved.error;
	const selected=[...architecture.globalItems,...architecture.projectItems];
	return {architecture,librarySync:{selected:selected.length,native:selected.filter((i:any)=>['library.native','memory.knowledge'].includes(i.provider)).length,profiles:selected.filter((i:any)=>i.provider==='base.profiles').length,filesystem:false,created:0,errors:[]}};
}
export function resolveKnowledgeItemPolicy(architecture:any,itemId:unknown){
	if(!architecture?.setupComplete)return null;
	const wanted=text(itemId);if(!wanted)return null;
	const matches=[...(architecture.globalItems||[]),...(architecture.projectItems||[])].filter((item:any)=>String(item.itemId)===wanted);
	matches.sort((a:any,b:any)=>itemScore(b)-itemScore(a));
	return matches[0]?structuredClone(matches[0]):null;
}
function liveItemMap(library:any):Map<string,any>{
	return new Map<string,any>((library.items||[]).filter((item:any)=>item.status==='active'&&nativeProvider(item.source?.provider)).map((item:any)=>[String(item.id),item]));
}
function enrich(entry:any,items:Map<string,any>){
	const item=items.get(String(entry.itemId));
	return item?{...entry,libraryItem:{id:item.id,name:item.name,kind:item.kind,category:item.category,roles:item.roles,lifecycle:item.lifecycleState||item.lifecycle,provider:item.source?.provider}}:null;
}
export async function knowledgeContextPlan(workspaceId:string,options:any={}){
	const [architecture,library]=await Promise.all([getKnowledgeArchitecture(workspaceId),librarySnapshot(workspaceId)]);
	const itemMap=liveItemMap(library);
	const projectId=text(options.projectId),projectName=text(options.projectName).toLowerCase();
	const project=(architecture.projects||[]).find((entry:any)=>entry.id===projectId||(projectName&&String(entry.name||'').toLowerCase()===projectName))||null;
	const global=[...(architecture.globalItems||[])].map((item:any)=>enrich(item,itemMap)).filter(Boolean).sort((a:any,b:any)=>itemScore(b)-itemScore(a));
	const projectItems=project?[...(architecture.projectItems||[])].filter((item:any)=>item.projectId===project.id).map((item:any)=>enrich(item,itemMap)).filter(Boolean).sort((a:any,b:any)=>itemScore(b)-itemScore(a)):[];	const combined=[...global,...projectItems].filter((item:any)=>item.state!=='archive'&&item.state!=='superseded');
	return {workspaceId,revision:Number(architecture.revision||0),schema:SCHEMA,project,primary:combined.filter((item:any)=>item.usage==='primary'),reference:combined.filter((item:any)=>item.usage==='reference'),loadingOwnedBy:'MCP OSS/CCS',automaticLoading:false,architectureUpdatedAt:architecture.updatedAt};
}
function scoreRoute(project:any,route:any,input:any={},projectMatched=false){
	const haystack=`${text(input.category)} ${text(input.name)} ${text(input.content)} ${text(input.projectName)}`.toLowerCase();
	let score=projectMatched?60:0;const reasons:string[]=[];if(projectMatched)reasons.push('project-match');
	if(text(input.category)&&String(route.label).toLowerCase()===text(input.category).toLowerCase()){score+=80;reasons.push('category-exact');}
	for(const token of tokenise(route.label))if(haystack.includes(token)){score+=18;reasons.push(`label:${token}`);}
	for(const token of tokenise(route.destinationLabel))if(haystack.includes(token)){score+=8;reasons.push(`destination:${token}`);}
	if(project)for(const token of tokenise(project.name))if(haystack.includes(token)){score+=6;reasons.push(`project:${token}`);}
	return {score,reasons};
}
export async function resolveKnowledgeRoute(workspaceId:string,input:any={}){
	const architecture:any=await getKnowledgeArchitecture(workspaceId);const candidates:any[]=[];
	const wanted=text(input.projectId||input.projectName).toLowerCase();
	for(const project of architecture.projects||[]){
		const projectMatched=Boolean(wanted&&(String(project.id).toLowerCase()===wanted||String(project.name).toLowerCase()===wanted));
		for(const route of project.routes||[]){const scored=scoreRoute(project,route,input,projectMatched);if(scored.score>0)candidates.push({scope:'project',project,route,...scored});}
	}
	for(const route of architecture.globalRoutes||[]){const scored=scoreRoute(null,route,input,false);if(scored.score>0)candidates.push({scope:'workspace',project:null,route,...scored});}
	candidates.sort((a,b)=>b.score-a.score);const best=candidates[0]||null;
	const compact=(entry:any)=>({scope:entry.scope,projectId:entry.project?.id||null,projectName:entry.project?.name||null,label:entry.route.label,destinationType:entry.route.destinationType,destinationId:entry.route.destinationId,destinationLabel:entry.route.destinationLabel,routing:entry.route.routing,score:entry.score});
	if(!best||best.score<18)return{matched:false,workspaceId,revision:Number(architecture.revision||0),schema:SCHEMA,source:'knowledge-architecture',candidates:candidates.slice(0,5).map(compact)};
	return{matched:true,workspaceId,revision:Number(architecture.revision||0),schema:SCHEMA,source:'knowledge-architecture',scope:best.scope,projectId:best.project?.id||null,projectName:best.project?.name||null,category:best.route.label,destinationType:best.route.destinationType,destinationId:best.route.destinationId,destinationLabel:best.route.destinationLabel,routing:best.route.routing,score:best.score,confidence:Math.min(.99,.5+best.score/200),reasons:best.reasons};
}export async function knowledgeArchitectureHealth(user:OrbitUser,workspaceId:string){
	const workspace=await getWorkspace(workspaceId);await requireWorkspaceAccess(user,workspace);
	const [architecture,library]=await Promise.all([getKnowledgeArchitecture(workspaceId),librarySnapshot(workspaceId)]);
	const active=new Map<string,any>(library.items.filter((item:any)=>item.status==='active'&&nativeProvider(item.source?.provider)).map((item:any)=>[String(item.id),item]));
	const selected=[...(architecture.globalItems||[]),...(architecture.projectItems||[])];
	const missing=selected.filter((entry:any)=>!active.has(String(entry.itemId))).map((entry:any)=>({itemId:entry.itemId,name:entry.name}));
	const db=getSupabaseAdmin();
	const [profiles,studio]=await Promise.all([
		db.from('orbitfs_profiles').select('id',{count:'exact',head:true}).eq('workspace_id',workspaceId),
		db.from('studio_documents').select('id',{count:'exact',head:true}).eq('workspace_id',workspaceId)
	]);
	return {workspaceId,revision:Number(architecture.revision||0),setup:{ok:architecture.setupComplete===true,revision:Number(architecture.revision||0)},library:{ok:missing.length===0,selected:selected.length,missing},profiles:{ok:!profiles.error,count:Number(profiles.count||0)},studio:{ok:!studio.error,count:Number(studio.count||0),mode:'serverless'},mcp:{relationship:'separate',loadingOwnedBy:'MCP OSS/CCS'},filesystem:false};
}
