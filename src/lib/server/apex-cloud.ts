import type { OrbitUser } from '$lib/server/auth';
import { getWorkspace,requireWorkspaceAccess,requireWorkspacePermission,isSystemAdmin } from '$lib/server/workspaces';
import { analyzeCloudRouting } from '$lib/server/routing-engine-cloud';
import { createLibraryChangeRequest,listLibraryChangeRequests } from '$lib/server/library';
import { assertApexLicensed, getApexProcessingCore, getApexWorkspaceSettings } from '$lib/server/apex-processing-core';
import { listApexJobs } from '$lib/server/apex-job-engine';
import { getAddonEngineState, noteAddonRequest } from '$lib/server/addon-engine';
import { APEX_POLICY_DEFAULTS, getApexExecutionPolicy, saveApexExecutionPolicy } from '$lib/server/apex-policy';

const fail=(m:string,s=400,c='APEX_ERROR')=>Object.assign(new Error(m),{status:s,code:c});
export { APEX_POLICY_DEFAULTS };

export async function apexPolicy(user:OrbitUser){
	if(!isSystemAdmin(user))throw fail('System Owner or Admin required',403);
	return getApexExecutionPolicy();
}

export async function saveApexPolicy(user:OrbitUser,input:any={}){
	if(!isSystemAdmin(user))throw fail('System Owner or Admin required',403);
	return saveApexExecutionPolicy(input);
}

export async function apexEngineState(){
	const [state,policy]=await Promise.all([getAddonEngineState('apex').catch(()=>null),getApexExecutionPolicy()]);
	const operational=Boolean(state?.installed&&state?.attached&&state?.linked&&state?.configured&&state?.available&&state?.mode!=='stopped'&&!policy.fullShutdown);
	return {
		state:state?.mode||'standby',
		ok:Boolean(state)&&state?.available!==false,
		operational,
		processingDisabled:policy.fullShutdown,
		residentProcess:false,
		mode:'serverless',
		eventDriven:true,
		setupComplete:state?.configured===true,
		installed:state?.installed===true,
		attached:state?.attached===true,
		linked:state?.linked===true,
		workspaceId:state?.workspaceId||null,
		lastRequestAt:state?.lastRequestAt||null,
		processor:{available:operational,target:'knowledge-package',finalOwner:'panel-library'},
		routing:{available:operational,target:'library-knowledge'},
		converter:{state:operational?'knowledge_formats_ready':'unavailable',available:operational,reason:operational?null:policy.fullShutdown?'APEX processing is administratively disabled.':'APEX must be attached, setup and running before Knowledge conversion can run.'},
		filesystem:false
	};
}

export async function apexWorkspaceStatus(user:OrbitUser,workspaceId:string){
	const ws=await getWorkspace(workspaceId);await requireWorkspaceAccess(user,ws);await assertApexLicensed();
	const [requests,jobs,core,engine,policy]=await Promise.all([
		listLibraryChangeRequests(user,workspaceId,{sourceSystem:'apex'}),
		listApexJobs(user,workspaceId),
		getApexProcessingCore(),
		apexEngineState(),
		getApexExecutionPolicy()
	]);
	return {
		workspaceId,
		engine,
		policy,
		processingCore:core,
		processingJobs:jobs,
		queue:(requests.requests||[]).filter((x:any)=>['pending','needs_target','applying'].includes(x.status)),
		history:(requests.requests||[]).filter((x:any)=>!['pending','needs_target','applying'].includes(x.status)).slice(0,100),
		filesystem:false
	};
}

export async function apexAnalyze(user:OrbitUser,workspaceId:string,input:any={}){
	const ws=await getWorkspace(workspaceId);await requireWorkspacePermission(user,ws,'sorter_scan');await assertApexLicensed();
	const [policy,processing]=await Promise.all([getApexExecutionPolicy(),getApexWorkspaceSettings(user,workspaceId)]);
	if(policy.fullShutdown)throw fail('APEX processing is disabled by the system administrator',423,'APEX_SHUTDOWN');
	if(input.automatic===true&&policy.serviceMode!=='automatic')throw fail('Automatic APEX routing is disabled; processing is currently on demand',403,'APEX_AUTOMATION_DISABLED');
	if(policy.blockAutomation&&input.automatic===true)throw fail('APEX automation is blocked by the system administrator',403,'APEX_AUTOMATION_BLOCKED');
	const state=await getAddonEngineState('apex');
	if(!state.installed||!state.attached||!state.linked||!state.configured)throw fail('Complete APEX installation, attachment and first-time setup before routing',409,'APEX_SETUP_REQUIRED');
	if(state.mode==='stopped')throw fail('APEX is stopped',423,'APEX_STOPPED');
	await noteAddonRequest('apex');
	const routing=processing.routing||{};
	return analyzeCloudRouting(user,workspaceId,input.entry||input,{...(input.settings||{}),enabled:true,allowKnowledge:routing.knowledgeArchitecture!==false,allowProjects:routing.projects!==false,allowProfiles:routing.profiles!==false});
}

export async function apexQueueSuggestion(user:OrbitUser,workspaceId:string,input:any={}){
	const ws=await getWorkspace(workspaceId);await requireWorkspacePermission(user,ws,'sorter_add_to_queue');await assertApexLicensed();
	const [policy,processing,state]=await Promise.all([getApexExecutionPolicy(),getApexWorkspaceSettings(user,workspaceId),getAddonEngineState('apex')]);
	if(policy.fullShutdown)throw fail('APEX processing is disabled by the system administrator',423,'APEX_SHUTDOWN');
	if(!state.installed||!state.attached||!state.linked||!state.configured)throw fail('Complete APEX installation, attachment and first-time setup before queueing suggestions',409,'APEX_SETUP_REQUIRED');
	if(state.mode==='stopped')throw fail('APEX is stopped',423,'APEX_STOPPED');
	await noteAddonRequest('apex');
	const suggestion=input.suggestion||{},entry=input.entry||{},routing=processing.routing||{};
	if(suggestion.kind==='profile_record_add'&&routing.profiles===false)throw fail('Profile routing is disabled in APEX configuration',403,'APEX_ROUTING_TARGET_DISABLED');
	if(['knowledge_record_add','library_item_update'].includes(String(suggestion.kind))&&routing.knowledgeArchitecture===false)throw fail('Knowledge routing is disabled in APEX configuration',403,'APEX_ROUTING_TARGET_DISABLED');
	if((suggestion.architectureRoute?.scope==='project'||suggestion.architectureRoute?.projectId)&&routing.projects===false)throw fail('Project routing is disabled in APEX configuration',403,'APEX_ROUTING_TARGET_DISABLED');
	let operation:any;
	if(suggestion.kind==='profile_record_add')operation={type:'profile_record_add',profileId:suggestion.profileId||null,sectionId:suggestion.sectionId||'records',title:entry.title||suggestion.label||'APEX suggestion',content:entry.content||entry.content_text||'',date:entry.date||entry.entryDate||null,category:entry.category||'apex'};
	else if(suggestion.kind==='library_item_update'&&suggestion.itemId)operation={type:'library_item_update',itemId:suggestion.itemId,patch:{content:entry.content||entry.content_text||''}};
	else operation={type:'knowledge_record_add',role:suggestion.role||'general_record_target',itemId:suggestion.existing?.itemId||null,title:entry.title||suggestion.label||'APEX suggestion',content:entry.content||entry.content_text||'',date:entry.date||entry.entryDate||null,category:entry.category||'apex'};
	const request=await createLibraryChangeRequest(user,workspaceId,{source:{system:'apex',title:entry.title||suggestion.label||'APEX routing suggestion'},sourceSnapshot:{entry,suggestion},summary:`APEX: ${entry.title||suggestion.label||'Knowledge routing suggestion'}`,reason:suggestion.reason||input.reason||'APEX routing suggestion',operations:[operation]});
	return {queued:true,request};
}
