import { getApexProcessingCore } from '$lib/server/apex-processing-core';
import { APEX_SUPPORTED_EXTENSIONS } from '$lib/server/apex-processing-types';
import { listApexProcessorCapabilities } from '$lib/server/apex-processors';
import { getAddonEngineState } from '$lib/server/addon-engine';
import { getApexExecutionPolicy } from '$lib/server/apex-policy';
import { getKnowledgeArchitecture } from '$lib/server/knowledge-architecture';
import { getSupabaseAdmin } from '$lib/server/supabase';

const FORMAT_LABELS:Record<string,string>={pdf:'PDF',docx:'DOCX',txt:'Text',md:'Markdown',markdown:'Markdown',html:'HTML',htm:'HTML',csv:'CSV',json:'JSON'};

async function integrationState(workspaceId:string|null|undefined){
	const mcp=await getAddonEngineState('mcp').catch(()=>null);
	if(!workspaceId){
		return {
			library:{reachable:false,workspaceId:null,canonicalStore:'orbitfs_library_state',owner:'panel-library'},
			knowledgeSetup:{available:false,setupComplete:false,revision:0,loadingOwner:'mcp-oss-ccs'},
			mcp:{optional:true,installed:Boolean(mcp?.installed),attached:Boolean(mcp?.attached),linked:Boolean(mcp?.linked),ready:false,contextBridge:'knowledge-architecture-managed-bundles'}
		};
	}
	const db=getSupabaseAdmin();
	const [library,architecture]=await Promise.all([
		db.from('orbitfs_library_state').select('state,updated_at').eq('workspace_id',workspaceId).maybeSingle(),
		getKnowledgeArchitecture(workspaceId).catch(()=>null)
	]);
	const libraryState:any=library.data?.state||{};
	return {
		library:{
			reachable:!library.error,
			workspaceId,
			canonicalStore:'orbitfs_library_state',
			owner:'panel-library',
			items:Array.isArray(libraryState.items)?libraryState.items.length:0,
			sections:Array.isArray(libraryState.sections)?libraryState.sections.length:0,
			updatedAt:library.data?.updated_at||null,
			error:library.error?String(library.error.message||library.error):null
		},
		knowledgeSetup:{
			available:Boolean(architecture),
			setupComplete:architecture?.setupComplete===true,
			revision:Number(architecture?.revision||0),
			primaryItems:[...(architecture?.globalItems||[]),...(architecture?.projectItems||[])].filter((item:any)=>item.usage==='primary'&&['active','final'].includes(String(item.state||'active'))).length,
			referenceItems:[...(architecture?.globalItems||[]),...(architecture?.projectItems||[])].filter((item:any)=>item.usage==='reference').length,
			loadingOwner:'mcp-oss-ccs'
		},
		mcp:{
			optional:true,
			installed:Boolean(mcp?.installed),
			attached:Boolean(mcp?.attached),
			linked:Boolean(mcp?.linked),
			ready:Boolean(mcp?.installed&&mcp?.attached&&mcp?.linked&&mcp?.configured&&mcp?.available&&mcp?.mode!=='stopped'),
			contextBridge:'knowledge-architecture-managed-bundles'
		}
	};
}

export async function apexCapabilities(){
	const [core,state,policy]=await Promise.all([getApexProcessingCore(),getAddonEngineState('apex'),getApexExecutionPolicy()]);
	const processors=listApexProcessorCapabilities();
	const byExtension=new Map<string,any>();for(const processor of processors)for(const extension of processor.extensions||[])byExtension.set(String(extension).replace(/^\./,'').toLowerCase(),processor);
	const runtimeAvailable=state.installed&&state.attached&&state.linked&&state.available&&state.mode!=='stopped'&&!policy.fullShutdown;
	const coreAvailable=core.initialized&&core.licensed&&runtimeAvailable;
	const allAdaptersPresent=[...APEX_SUPPORTED_EXTENSIONS].every((extension)=>byExtension.has(extension));
	const integrations=await integrationState(state.workspaceId);
	return {
		engine:'apex',
		processingVersion:core.version,
		initialized:core.initialized,
		mode:'serverless',
		filesystem:false,
		knowledgeIngest:{
			coreAvailable,
			available:coreAvailable&&allAdaptersPresent,
			output:'knowledge-package',
			owner:'engine-host',
			finalOwner:'panel-library',
			features:['normalize','structure','chunk','source-hash','content-hash','duplicate-detection','revision-detection','knowledge-routing','source-tracking','library-index-provenance','mcp-context-bridge']
		},
		integrations,
		processors,
		extraction:[...APEX_SUPPORTED_EXTENSIONS].map((extension)=>{const processor=byExtension.get(extension);const adapterAvailable=Boolean(processor);return {extension,label:FORMAT_LABELS[extension]||extension.toUpperCase(),registered:adapterAvailable,adapter:processor?.id||null,adapterVersion:processor?.version||null,available:coreAvailable&&adapterAvailable,reason:!adapterAvailable?'Extraction adapter is not registered':!runtimeAvailable?'APEX runtime is stopped, detached or administratively disabled':!core.initialized?'APEX processing core is not initialized':!core.licensed?'APEX is not licensed':null};}),
		conversion:{
			knowledgeFormats:{coreAvailable,available:coreAvailable&&allAdaptersPresent,execution:'apex-document-pipeline'},
			heavyMedia:{available:false,execution:'external-worker',reason:'Native media conversion is outside the serverless APEX Knowledge pipeline.'},
			officeRendering:{available:false,execution:'external-worker',reason:'Native Office rendering is outside the serverless APEX Knowledge pipeline.'},
			windowsManagedRuntimes:false
		},
		runtime:{
			available:runtimeAvailable,
			state:state.mode,
			setupComplete:state.configured,
			fullShutdown:policy.fullShutdown,
			eventDriven:true,
			residentProcess:false,
			standbySupported:policy.standby,
			sourceStore:'shared-supabase',
			jobStore:'shared-supabase'
		}
	};
}
