import { fail } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth';
import { writeAudit } from '$lib/server/audit';
import { getEngineReadiness } from '$lib/server/engine-readiness';
import { markEngineConfigurationReviewed, setEngineSetupState } from '$lib/server/engine-hub';
import { initializeApexProcessingCore } from '$lib/server/apex-processing-core';

function canManage(user:any){return ['owner','admin'].includes(String(user?.role||'').toLowerCase());}
const actionFail=(error:any,fallback:string)=>fail(Number(error?.status||500),{error:String(error?.message||fallback),code:String(error?.code||'ENGINE_SETUP_ERROR')});

export async function load({cookies,params}){
	const user=await requireUser(cookies);
	const readiness=await getEngineReadiness(params.engine);
	return {user,...readiness,canManage:canManage(user)};
}

async function auditSetup(user:any,readiness:any,action:string,state:string,detail:Record<string,unknown>={}){
	await writeAudit({actorUserId:String(user.id),workspaceId:readiness.engine.workspaceId||null,action,targetType:'engine',targetId:readiness.engine.id,detail:{setupState:state,engineHost:readiness.engine.hostUrl||null,...detail}});
}

export const actions={
	begin:async({cookies,params})=>{
		const user=await requireUser(cookies);
		if(!canManage(user))return fail(403,{error:'Engine setup requires an OrbitFS administrator.'});
		try{
			const readiness=await getEngineReadiness(params.engine);
			if(!readiness.engine.linked)return fail(409,{error:'Attach and link this engine from OrbitFS Panel before starting setup.'});

			let coreInitialized=false;
			if(params.engine==='apex'){
				coreInitialized=readiness.apex?.core?.initialized===true;
				if(!coreInitialized){
					const core=await initializeApexProcessingCore(user);
					coreInitialized=core.initialized===true;
				}
			}

			const engine=await setEngineSetupState(params.engine,'in_progress',String(user.id));
			await auditSetup(user,readiness,'engine.setup.begin','in_progress',{apexProcessingCoreReady:params.engine==='apex'?coreInitialized:undefined});
			return {
				ok:true,
				message:params.engine==='apex'?'APEX setup is in progress. Required processing core is ready.':'Setup is in progress.',
				setupState:engine.setupState
			};
		}catch(error){return actionFail(error,'Setup could not start.');}
	},
	core:async({cookies,params})=>{
		const user=await requireUser(cookies);
		if(!canManage(user))return fail(403,{error:'Engine setup requires an OrbitFS administrator.'});
		if(params.engine!=='apex')return fail(400,{error:'This Engine does not use the APEX processing core.'});
		try{
			const readiness=await getEngineReadiness(params.engine);
			if(!readiness.engine.linked)return fail(409,{error:'Attach and link APEX from OrbitFS Panel before initializing its processing core.'});
			const before=readiness.apex?.core?.initialized===true;
			const core=before?readiness.apex.core:await initializeApexProcessingCore(user);
			await auditSetup(user,readiness,'engine.apex.processing_core.verify',String(readiness.engine.setupState||'required'),{initialized:core.initialized,version:core.version,wasAlreadyInitialized:before});
			return {ok:true,message:before?'APEX processing core verified.':'APEX processing core initialized and workspace defaults created.'};
		}catch(error){return actionFail(error,'APEX processing core could not be initialized.');}
	},
	review:async({cookies,params})=>{
		const user=await requireUser(cookies);
		if(!canManage(user))return fail(403,{error:'Engine setup requires an OrbitFS administrator.'});
		try{
			const readiness=await getEngineReadiness(params.engine);
			if(!readiness.engine.linked)return fail(409,{error:'Attach and link this engine from OrbitFS Panel before reviewing configuration.'});
			if(params.engine==='apex'&&readiness.apex?.core?.initialized!==true)return fail(409,{error:'Initialize the APEX processing core before marking configuration reviewed.'});
			const engine=await markEngineConfigurationReviewed(params.engine,String(user.id));
			await auditSetup(user,readiness,'engine.setup.configuration_review','in_progress',{configurationReviewed:true});
			return {ok:true,message:'Configuration review recorded.',setupState:engine.setupState};
		}catch(error){return actionFail(error,'Configuration review could not be recorded.');}
	},
	complete:async({cookies,params})=>{
		const user=await requireUser(cookies);
		if(!canManage(user))return fail(403,{error:'Engine setup requires an OrbitFS administrator.'});
		try{
			const readiness=await getEngineReadiness(params.engine);
			if(!readiness.ready)return fail(409,{error:`Setup cannot complete yet. Blocking checks: ${readiness.blocking.join(', ')}.`});
			const engine=await setEngineSetupState(params.engine,'complete',String(user.id));
			await auditSetup(user,readiness,'engine.setup.complete','complete',{configured:engine.configured===true,panelStateReady:engine.configured===true});
			return {ok:true,message:'Engine setup is complete and the add-on is marked configured for OrbitFS Panel.',setupState:engine.setupState,configured:engine.configured};
		}catch(error){return actionFail(error,'Setup could not be completed.');}
	},
	rerun:async({cookies,params})=>{
		const user=await requireUser(cookies);
		if(!canManage(user))return fail(403,{error:'Engine setup requires an OrbitFS administrator.'});
		try{
			const readiness=await getEngineReadiness(params.engine);
			const engine=await setEngineSetupState(params.engine,'required',String(user.id));
			await auditSetup(user,readiness,'engine.setup.reopen','required');
			return {ok:true,message:'Setup reopened. The previous configuration review was reset.',setupState:engine.setupState};
		}catch(error){return actionFail(error,'Setup could not be reopened.');}
	}
};
