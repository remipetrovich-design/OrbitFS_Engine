import { getSupabaseAdmin } from '$lib/server/supabase';
import { getPanelLicenseSummary, componentLicensed } from '$lib/server/license';
import { getAddonEngineState, assertAddonEngineAccepting, noteAddonRequest } from '$lib/server/addon-engine';
import { getWorkspace, requireWorkspacePermission } from '$lib/server/workspaces';
import { requireCapability } from '$lib/server/base-compat';
import type { OrbitUser } from '$lib/server/auth';
import { APEX_PROCESSING_VERSION, APEX_SUPPORTED_EXTENSIONS, APEX_SUPPORTED_MIME_TYPES, type ApexImportMode, type ApexSourceDescriptor } from '$lib/server/apex-processing-types';
import { apexExtensionFromSource, apexSourceFormatConflict } from '$lib/server/apex-source-format';

const CORE_KEY='apex.processing.core';
const SETTINGS_KEY='apex.processing.settings';
const now=()=>new Date().toISOString();
const fail=(message:string,status=400,code='APEX_PROCESSING_ERROR')=>Object.assign(new Error(message),{status,code});

export const APEX_PROCESSING_DEFAULTS={
	importMode:'knowledge' as ApexImportMode,
	preserveSource:true,
	autoCreateNew:true,
	duplicatePolicy:'review',
	revisionPolicy:'review',
	normalize:true,
	chunkTargetChars:4000,
	chunkOverlapChars:400,
	maxSourceBytes:50*1024*1024,
	acceptedExtensions:[...APEX_SUPPORTED_EXTENSIONS],
	routing:{knowledgeArchitecture:true,projects:true,profiles:true,approvalForExisting:true},
	sourceTracking:{pages:true,sections:true,hashes:true,processorVersion:true}
};

function objectValue(value:unknown):Record<string,any>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};}
function hintedEngine(value:any){return value?.state&&typeof value.state==='object'?value.state:value;}
async function readSetting(scopeType:string,scopeId:string,key:string){
	const db=getSupabaseAdmin();
	const r=await db.from('orbitfs_settings').select('value,updated_at').eq('scope_type',scopeType).eq('scope_id',scopeId).eq('key',key).maybeSingle();
	if(r.error)throw r.error;
	return {value:objectValue(r.data?.value),updatedAt:r.data?.updated_at||null};
}
async function writeSetting(scopeType:string,scopeId:string,key:string,value:Record<string,any>){
	const db=getSupabaseAdmin();const updatedAt=now();
	const r=await db.from('orbitfs_settings').upsert({scope_type:scopeType,scope_id:scopeId,key,value,updated_at:updatedAt},{onConflict:'scope_type,scope_id,key'});
	if(r.error)throw r.error;
	return {value,updatedAt};
}

export async function assertApexLicensed(){
	const license=await getPanelLicenseSummary();
	if(!license.licensed)throw fail('OrbitFS Base licence is required before APEX can run',403,'BASE_LICENSE_REQUIRED');
	const component=objectValue(license.components?.orbitfs_apex);
	if(!componentLicensed(component))throw fail('OrbitFS APEX is not licensed for this installation',403,'APEX_LICENSE_REQUIRED');
	return {license,component};
}

export async function getApexProcessingCore(engineHint?:any){
	const stored=await readSetting('global','',CORE_KEY);
	let engine:any=hintedEngine(engineHint);
	let licensed=engineHint?engineHint.licensed!==false:true;
	let licenseReason:string|null=null;
	if(!engine){
		const [engineState,licence]=await Promise.all([getAddonEngineState('apex'),assertApexLicensed().catch((error:any)=>({error}))]);
		engine=engineState;
		licensed=!('error' in licence);
		licenseReason=licensed?null:String((licence as any).error?.code||(licence as any).error?.message||'APEX_LICENSE_REQUIRED');
	}
	const core=stored.value;
	return {
		version:Number(core.version||0),
		initialized:core.initialized===true&&Number(core.version||0)>=APEX_PROCESSING_VERSION,
		initializedAt:core.initializedAt||null,
		initializedByUserId:core.initializedByUserId||null,
		processingOwner:core.processingOwner||'engine-host',
		knowledgeOwner:core.knowledgeOwner||'panel-library',
		storage:'supabase',
		filesystem:false,
		mode:'serverless',
		supportedExtensions:[...APEX_SUPPORTED_EXTENSIONS],
		supportedMimeTypes:[...APEX_SUPPORTED_MIME_TYPES],
		engine,
		licensed,
		licenseReason,
		updatedAt:stored.updatedAt
	};
}

export async function initializeApexProcessingCore(user:OrbitUser){
	await assertApexLicensed();
	const engine=await getAddonEngineState('apex');
	if(!engine.installed)throw fail('Install APEX from Panel before first-time setup',409,'APEX_NOT_INSTALLED');
	if(!engine.attached||!engine.linked)throw fail('Attach and link APEX from Panel before first-time setup',409,'APEX_NOT_LINKED');
	if(!engine.workspaceId)throw fail('APEX Engine Host link has no workspace',409,'APEX_WORKSPACE_REQUIRED');
	await getWorkspace(engine.workspaceId);

	const existing=await readSetting('global','',CORE_KEY);
	const current=existing.value;
	const alreadyCurrent=current.initialized===true&&Number(current.version||0)>=APEX_PROCESSING_VERSION;
	const core={
		version:APEX_PROCESSING_VERSION,
		initialized:true,
		initializedAt:current.initializedAt||now(),
		initializedByUserId:current.initializedByUserId||String(user.id),
		processingOwner:'engine-host',
		knowledgeOwner:'panel-library',
		queueStore:'supabase-settings',
		sourceStore:'orbitfs-files',
		canonicalKnowledgeStore:'orbitfs-library-state',
		filesystem:false,
		mode:'serverless',
		supportedExtensions:[...APEX_SUPPORTED_EXTENSIONS],
		supportedMimeTypes:[...APEX_SUPPORTED_MIME_TYPES]
	};
	if(!alreadyCurrent)await writeSetting('global','',CORE_KEY,core);
	await ensureApexWorkspaceSettings(engine.workspaceId);

	const db=getSupabaseAdmin();
	const row=await db.from('orbitfs_addons').select('config,runtime').eq('id','apex').maybeSingle();
	if(row.error)throw row.error;
	const config=objectValue(row.data?.config),runtime=objectValue(row.data?.runtime);
	const apexProcessing=objectValue(config.apexProcessing);
	const needsAddonSync=!alreadyCurrent||String(apexProcessing.workspaceId||'')!==engine.workspaceId||Number(apexProcessing.version||0)<APEX_PROCESSING_VERSION;
	if(needsAddonSync){
		const stamp=now();
		const update=await db.from('orbitfs_addons').update({
			config:{...config,apexProcessing:{...core,workspaceId:engine.workspaceId,configuredAt:stamp}},
			runtime:{...runtime,setupVersion:2,processingVersion:APEX_PROCESSING_VERSION,processingMode:'event_driven',compute:'vercel',database:'supabase',filesystem:false,deployment:'ready'},
			updated_at:stamp
		}).eq('id','apex');
		if(update.error)throw update.error;
	}
	return getApexProcessingCore(engine);
}

export async function ensureApexWorkspaceSettings(workspaceId:string){
	await getWorkspace(workspaceId);
	const stored=await readSetting('workspace',workspaceId,SETTINGS_KEY);
	const raw=stored.value;
	const next={...APEX_PROCESSING_DEFAULTS,...raw,routing:{...APEX_PROCESSING_DEFAULTS.routing,...objectValue(raw.routing)},sourceTracking:{...APEX_PROCESSING_DEFAULTS.sourceTracking,...objectValue(raw.sourceTracking)}};
	if(!stored.updatedAt)await writeSetting('workspace',workspaceId,SETTINGS_KEY,next);
	return next;
}

export async function getApexWorkspaceSettings(user:OrbitUser,workspaceId:string){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_view');
	return ensureApexWorkspaceSettings(workspaceId);
}

export async function saveApexWorkspaceSettings(user:OrbitUser,workspaceId:string,input:any={}){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_manage_rules');await assertApexLicensed();
	const current=await ensureApexWorkspaceSettings(workspaceId);
	const importMode=(['knowledge','reference','draft'] as string[]).includes(String(input.importMode))?String(input.importMode) as ApexImportMode:current.importMode;
	const accepted=Array.isArray(input.acceptedExtensions)?input.acceptedExtensions.map((x:any)=>String(x).toLowerCase().replace(/^\./,'')).filter((x:string)=>APEX_SUPPORTED_EXTENSIONS.includes(x as any)):current.acceptedExtensions;
	const next={
		...current,
		importMode,
		preserveSource:true,
		autoCreateNew:input.autoCreateNew!==false,
		duplicatePolicy:'review',revisionPolicy:'review',normalize:input.normalize!==false,
		chunkTargetChars:Math.max(1000,Math.min(16000,Number(input.chunkTargetChars||current.chunkTargetChars||4000))),
		chunkOverlapChars:Math.max(0,Math.min(2000,Number(input.chunkOverlapChars??current.chunkOverlapChars??400))),
		maxSourceBytes:Math.max(1024*1024,Math.min(250*1024*1024,Number(input.maxSourceBytes||current.maxSourceBytes))),
		acceptedExtensions:[...new Set(accepted.length?accepted:current.acceptedExtensions)],
		routing:{...current.routing,...objectValue(input.routing),approvalForExisting:true},
		sourceTracking:{...current.sourceTracking,...objectValue(input.sourceTracking),hashes:true,processorVersion:true},
		updatedAt:now(),updatedByUserId:String(user.id)
	};
	await writeSetting('workspace',workspaceId,SETTINGS_KEY,next);return next;
}

export async function getApexSource(workspaceId:string,sourceId:string):Promise<ApexSourceDescriptor>{
	const db=getSupabaseAdmin();
	const r=await db.from('orbitfs_files').select('id,workspace_id,name,path,kind,mime_type,size_bytes,storage_path,updated_at,deleted_at').eq('workspace_id',workspaceId).eq('id',sourceId).maybeSingle();
	if(r.error)throw r.error;
	const row:any=r.data;if(!row||row.deleted_at||row.kind!=='file')throw fail('APEX source asset was not found',404,'APEX_SOURCE_NOT_FOUND');
	const mimeType=row.mime_type?String(row.mime_type):null;const extension=apexExtensionFromSource(String(row.name||''),String(row.path||''),mimeType);
	return {id:String(row.id),workspaceId:String(row.workspace_id),name:String(row.name||'source'),path:String(row.path||''),extension,mimeType,sizeBytes:Number(row.size_bytes||0),storagePath:row.storage_path?String(row.storage_path):null,updatedAt:row.updated_at||null};
}

export async function assertApexSourceAllowed(user:OrbitUser,workspaceId:string,sourceId:string){
	const workspace=await getWorkspace(workspaceId);await requireWorkspacePermission(user,workspace,'sorter_scan');await assertApexLicensed();
	const engine=await assertAddonEngineAccepting('apex');
	if(engine.setupState!=='complete')throw fail('Complete APEX first-time setup before submitting processing jobs',409,'APEX_SETUP_REQUIRED');
	const core=await readSetting('global','',CORE_KEY);if(core.value.initialized!==true||Number(core.value.version||0)<APEX_PROCESSING_VERSION)throw fail('APEX processing core is not initialized',409,'APEX_SETUP_REQUIRED');
	const settings=await ensureApexWorkspaceSettings(workspaceId),source=await getApexSource(workspaceId,sourceId);
	await requireCapability(user, workspaceId, String(source.path), 'read');
	if(!settings.acceptedExtensions.includes(source.extension as typeof APEX_SUPPORTED_EXTENSIONS[number]))throw fail(`APEX does not accept .${source.extension||'unknown'} Knowledge sources`,415,'APEX_SOURCE_TYPE_UNSUPPORTED');
	if(apexSourceFormatConflict(source.extension,source.mimeType))throw fail(`APEX source format mismatch: .${source.extension} does not match ${source.mimeType}`,415,'APEX_SOURCE_FORMAT_MISMATCH');
	if(source.sizeBytes>Number(settings.maxSourceBytes))throw fail('APEX source exceeds the configured import size limit',413,'APEX_SOURCE_TOO_LARGE');
	await noteAddonRequest('apex');return {workspace,settings,source};
}

export async function getApexSetupReadiness(engineHint?:any){
	const engine=hintedEngine(engineHint)||await getAddonEngineState('apex');
	const storedCore=await readSetting('global','',CORE_KEY);
	const coreValue=storedCore.value;
	const core={
		version:Number(coreValue.version||0),
		initialized:coreValue.initialized===true&&Number(coreValue.version||0)>=APEX_PROCESSING_VERSION,
		initializedAt:coreValue.initializedAt||null,
		processingOwner:coreValue.processingOwner||'engine-host',
		knowledgeOwner:coreValue.knowledgeOwner||'panel-library',
		storage:'supabase',filesystem:false,mode:'serverless',engine,licensed:engine.licensed!==false,updatedAt:storedCore.updatedAt
	};
	const workspaceId=engine.workspaceId;
	let workspaceSettings=false,workspaceValid=false,libraryReachable=false,knowledgeArchitectureAvailable=false,knowledgeArchitectureSetup=false;
	let mcpInstalled=false,mcpAttached=false,mcpConfigured=false,mcpAvailable=false,mcpMode:string|null=null;
	if(workspaceId){
		const db=getSupabaseAdmin();
		const [workspace,settings,library,architecture,mcp]=await Promise.all([
			db.from('orbitfs_workspaces').select('id').eq('id',workspaceId).maybeSingle(),
			readSetting('workspace',workspaceId,SETTINGS_KEY).catch(()=>({value:{},updatedAt:null})),
			db.from('orbitfs_library_state').select('workspace_id').eq('workspace_id',workspaceId).limit(1),
			db.from('orbitfs_settings').select('value').eq('scope_type','workspace').eq('scope_id',workspaceId).eq('key','knowledge_architecture').maybeSingle(),
			db.from('orbitfs_addons').select('installed,attached,configured,available,runtime').eq('id','mcp').maybeSingle()
		]);
		workspaceValid=!workspace.error&&Boolean(workspace.data);
		workspaceSettings=Boolean(settings.updatedAt);
		libraryReachable=!library.error;
		knowledgeArchitectureAvailable=!architecture.error;
		knowledgeArchitectureSetup=(architecture.data?.value as any)?.setupComplete===true;
		if(!mcp.error&&mcp.data){
			mcpInstalled=mcp.data.installed===true;mcpAttached=mcp.data.attached===true;mcpConfigured=mcp.data.configured===true;mcpAvailable=mcp.data.available!==false;
			mcpMode=String((mcp.data.runtime as any)?.engineMode||'running');if(mcpMode==='standby')mcpMode='running';
		}
	}
	const libraryIntegration=workspaceValid&&libraryReachable&&core.knowledgeOwner==='panel-library'&&core.processingOwner==='engine-host'&&core.filesystem===false;
	return {
		core,workspaceValid,workspaceSettings,libraryIntegration,
		knowledgeArchitecture:{available:knowledgeArchitectureAvailable,setupComplete:knowledgeArchitectureSetup},
		mcpIntegration:{optional:true,installed:mcpInstalled,attached:mcpAttached,configured:mcpConfigured,available:mcpAvailable,mode:mcpMode,ready:!mcpInstalled||(mcpAttached&&mcpConfigured&&mcpAvailable&&mcpMode!=='stopped')},
		runtime:engine.deployment!=='error'&&engine.compute==='vercel'&&['supabase','shared-panel'].includes(String(engine.database||''))
	};
}
