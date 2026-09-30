import { fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { writeAudit } from '$lib/server/audit';
import { apexPolicy, saveApexPolicy } from '$lib/server/apex-cloud';
import { getApexProcessingCore, getApexWorkspaceSettings, initializeApexProcessingCore, saveApexWorkspaceSettings } from '$lib/server/apex-processing-core';
import { setAddonEngineMode } from '$lib/server/addon-engine';
import { getEngineHubEngine } from '$lib/server/engine-hub';
import { getMcpEngineSettings, saveMcpEngineSettings } from '$lib/server/mcp-engine-settings';
import { getMcpAdminPolicy, saveMcpAdminPolicy } from '$lib/server/mcp-admin-policy';
import { getStudioAdminSettings, updateStudioAdminSettings } from '$lib/server/studio-cloud';

function checked(form:FormData,key:string){return form.get(key)==='on'||form.get(key)==='true';}
function boundedNumber(form:FormData,key:string,fallback:number,min:number,max:number){const raw=form.get(key);if(raw===null||raw==='')return fallback;const value=Number(raw);return Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;}
function percent(form:FormData,key:string,fallback:number){return boundedNumber(form,key,Math.round(fallback*100),0,100)/100;}
const actionFail=(error:any,fallback:string)=>fail(Number(error?.status||500),{error:String(error?.message||fallback),code:String(error?.code||'ENGINE_CONFIGURATION_ERROR')});

export async function load({cookies,params}){
	const user=await requireAdmin(cookies);
	const engine=await getEngineHubEngine(params.engine);
	let settings:any=null,processingSettings:any=null,processingCore:any=null,mcpPolicy:any=null;
	if(engine.id==='mcp'){
		[settings,mcpPolicy]=await Promise.all([getMcpEngineSettings(),getMcpAdminPolicy()]);
	}
	if(engine.id==='apex'){
		settings=await apexPolicy(user);
		processingCore=await getApexProcessingCore(engine);
		// Opening configuration must not initialize/write APEX state. First-time setup owns that.
		if(engine.workspaceId&&processingCore.initialized)processingSettings=await getApexWorkspaceSettings(user,engine.workspaceId).catch(()=>null);
	}
	if(engine.id==='studio')settings=await getStudioAdminSettings(user);
	return {user,engine,settings,processingSettings,processingCore,mcpPolicy};
}

export const actions={
	core:async({cookies,params})=>{
		const user=await requireAdmin(cookies);
		try{
			const engine=await getEngineHubEngine(params.engine);
			if(engine.id!=='apex')return fail(400,{error:'Only APEX uses this processing core.'});
			if(!engine.installed||!engine.attached||!engine.linked)return fail(409,{error:'Install and link APEX from Panel before initializing its processing core.'});
			const before=await getApexProcessingCore(engine);
			const core=await initializeApexProcessingCore(user);
			await writeAudit({actorUserId:String(user.id),workspaceId:engine.workspaceId||null,action:'engine.apex.processing_core.verify',targetType:'engine',targetId:'apex',detail:{initialized:core.initialized,version:core.version,wasAlreadyInitialized:before.initialized===true}});
			return {ok:true,message:before.initialized?'APEX processing core verified.':'APEX processing core initialized.',processingCore:core};
		}catch(error){return actionFail(error,'APEX processing core could not be initialized.');}
	},
	save:async({cookies,params,request})=>{
		const user=await requireAdmin(cookies);
		try{
			const engine=await getEngineHubEngine(params.engine);
			if(!engine.installed||!engine.attached||!engine.linked)return fail(409,{error:'Install and attach this engine from Panel before changing Engine Host configuration.'});
			const form=await request.formData();
			let settings:any,processingSettings:any=null,mcpPolicy:any=null;
			if(engine.id==='mcp'){
				settings=await saveMcpEngineSettings({
					accessTokenMinutes:Math.round(boundedNumber(form,'accessTokenMinutes',60,5,1440)),refreshTokenDays:Math.round(boundedNumber(form,'refreshTokenDays',30,1,90)),authorizationCodeMinutes:Math.round(boundedNumber(form,'authorizationCodeMinutes',10,1,30)),
					allowWriteScope:checked(form,'allowWriteScope'),allowOfflineAccess:checked(form,'allowOfflineAccess'),dynamicClientRegistration:checked(form,'dynamicClientRegistration'),maxRequestKb:Math.round(boundedNumber(form,'maxRequestKb',1024,64,16384)),requireJsonContentType:checked(form,'requireJsonContentType'),allowDeleteTransport:checked(form,'allowDeleteTransport'),mirrorUiState:checked(form,'mirrorUiState'),logRejectedRequests:checked(form,'logRejectedRequests')
				},String(user.id));
				const allowedStrengths=['low','medium','high','custom1','custom2'].filter((key)=>checked(form,`ossStrength_${key}`));
				mcpPolicy=await saveMcpAdminPolicy({
					oss:{enabled:checked(form,'ossEnabled'),allowedStrengths,maxBundlesPerPreset:Math.round(boundedNumber(form,'maxBundlesPerPreset',20,1,100))},
					ccs:{enabled:checked(form,'ccsEnabled'),maxBundlesPerWorkspace:Math.round(boundedNumber(form,'maxBundlesPerWorkspace',100,1,1000)),maxEntriesPerBundle:Math.round(boundedNumber(form,'maxEntriesPerBundle',500,1,5000)),maxDependenciesPerBundle:Math.round(boundedNumber(form,'maxDependenciesPerBundle',50,0,500)),maxDependencyDepth:Math.round(boundedNumber(form,'maxDependencyDepth',8,1,32)),allowProfiles:checked(form,'ccsAllowProfiles')}
				});
			}else if(engine.id==='apex'){
				const core=await getApexProcessingCore(engine);
				if(!core.initialized)return fail(409,{error:'Initialize the APEX processing core before saving APEX configuration.'});
				const mode=String(form.get('serviceMode')||'on_demand');
				settings=await saveApexPolicy(user,{serviceMode:mode==='automatic'?'automatic':'on_demand',fullShutdown:checked(form,'fullShutdown'),standby:checked(form,'standby'),blockAutomation:checked(form,'blockAutomation'),idleTimeoutMs:Math.round(boundedNumber(form,'idleTimeoutSeconds',10,5,300)*1000)});
				if(!engine.workspaceId)return fail(409,{error:'APEX has no linked workspace.'});
				const current=await getApexWorkspaceSettings(user,engine.workspaceId);
				processingSettings=await saveApexWorkspaceSettings(user,engine.workspaceId,{
					importMode:String(form.get('importMode')||current.importMode||'knowledge'),autoCreateNew:checked(form,'autoCreateNew'),normalize:checked(form,'normalize'),chunkTargetChars:Math.round(boundedNumber(form,'chunkTargetChars',Number(current.chunkTargetChars||4000),1000,16000)),chunkOverlapChars:Math.round(boundedNumber(form,'chunkOverlapChars',Number(current.chunkOverlapChars||400),0,2000)),maxSourceBytes:Math.round(boundedNumber(form,'maxSourceMb',Math.round(Number(current.maxSourceBytes||50*1024*1024)/1024/1024),1,250)*1024*1024),routing:{knowledgeArchitecture:checked(form,'routingKnowledgeArchitecture'),projects:checked(form,'routingProjects'),profiles:checked(form,'routingProfiles'),approvalForExisting:true}
				});
				if(settings.standby===false&&engine.configured&&engine.engineState==='standby')await setAddonEngineMode('apex','running',String(user.id));
			}else if(engine.id==='studio'){
				const current=(await getStudioAdminSettings(user)).settings;
				settings=await updateStudioAdminSettings(user,{routingEnabled:checked(form,'routingEnabled'),routingAutoAnalyzeCreate:checked(form,'routingAutoAnalyzeCreate'),routingAutoAnalyzeUpdate:checked(form,'routingAutoAnalyzeUpdate'),routingMinConfidence:percent(form,'routingMinConfidencePercent',Number(current.routingMinConfidence??0.5)),routingProfileConfidence:percent(form,'routingProfileConfidencePercent',Number(current.routingProfileConfidence??0.5)),routingIncidentConfidence:percent(form,'routingIncidentConfidencePercent',Number(current.routingIncidentConfidence??0.5)),routingTimelineConfidence:percent(form,'routingTimelineConfidencePercent',Number(current.routingTimelineConfidence??0.5)),routingMaxSuggestions:Math.round(boundedNumber(form,'routingMaxSuggestions',Number(current.routingMaxSuggestions??5),1,20)),routingMaxCharacters:Math.round(boundedNumber(form,'routingMaxCharacters',Number(current.routingMaxCharacters??50000),1000,200000)),analysisPolicy:current.analysisPolicy});
			}else return fail(400,{error:'Unknown Engine configuration.'});
			await writeAudit({actorUserId:String(user.id),workspaceId:engine.workspaceId||null,action:`engine.${engine.id}.configuration.update`,targetType:'engine',targetId:engine.id,detail:{engineHost:engine.hostUrl||null,processingSettingsUpdated:engine.id==='apex',mcpPolicyUpdated:engine.id==='mcp'}});
			return {ok:true,message:`${engine.name} configuration saved.`,settings,processingSettings,mcpPolicy};
		}catch(error){return actionFail(error,'Engine configuration could not be saved.');}
	}
};
