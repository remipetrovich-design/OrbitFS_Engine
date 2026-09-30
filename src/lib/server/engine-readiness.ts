import { getEngineHubEngine } from '$lib/server/engine-hub';
import { getApexSetupReadiness } from '$lib/server/apex-processing-core';
import { listApexProcessorCapabilities } from '$lib/server/apex-processors';
import { APEX_SUPPORTED_EXTENSIONS } from '$lib/server/apex-processing-types';

export type EngineReadinessCheck = {
	id: string;
	label: string;
	description: string;
	ok: boolean;
	required: boolean;
};

export async function getEngineReadiness(engineId: string) {
	const engine = await getEngineHubEngine(engineId);
	// If the engine registry/licence/host reads above succeeded, the shared backend is reachable.
	// Do not run a second throwaway Supabase probe just to prove the same thing again.
	const backendReady = true;
	const pairingReady = engine.hostLinked === true && Boolean(engine.panelUrl) && Boolean(engine.hostUrl);
	const checks: EngineReadinessCheck[] = [
		{id:'shared_backend',label:'Shared OrbitFS backend',description:'Engine Host can read the shared Supabase engine registry.',ok:backendReady,required:true},
		{id:'pairing_registry',label:'Panel pairing registry',description:pairingReady?'The customer Engine Host has a linked Panel and Host URL.':'The Shared Engine Host pairing record is incomplete or not linked.',ok:pairingReady,required:true},
		{id:'registered',label:'Engine registered',description:'The engine exists in the shared OrbitFS add-on registry.',ok:engine.registered===true,required:true},
		{id:'installed',label:'Installed from Panel',description:'OrbitFS Panel has installed this engine for the current installation.',ok:engine.installed===true,required:true},
		{id:'licensed',label:'Licence entitlement',description:'The shared OrbitFS licence allows this engine on this installation.',ok:engine.licensed===true,required:true},
		{id:'attached',label:'Attached in Panel',description:'The engine has been attached from OrbitFS Panel.',ok:engine.attached===true,required:true},
		{id:'linked',label:'Panel link confirmed',description:'Panel and Engine Host agree on the installation and workspace pairing.',ok:engine.linked===true,required:true},
		{id:'workspace',label:'Workspace assigned',description:'The Engine Host link points at a shared OrbitFS workspace.',ok:Boolean(engine.workspaceId),required:true},
		{
			id:'configuration',label:'Configuration reviewed',
			description:engine.id==='mcp'?'An administrator reviewed MCP OAuth and connection configuration.':engine.id==='apex'?'An administrator reviewed APEX processing, Knowledge ingest and routing configuration.':`An administrator reviewed the current ${engine.name} Engine Host configuration.`,
			ok:Boolean(engine.configurationReviewedAt),required:true
		},
		{
			id:'runtime',label:'Runtime available',
			description:engine.id==='mcp'?'MCP is available unless explicitly stopped.':'The engine runtime is available. APEX may remain in Standby and accept on-demand work.',
			ok:engine.available!==false&&engine.state?.deployment!=='error'&&engine.engineState!=='stopped',required:true
		}
	];

	if(engine.id==='mcp'){
		checks.push({id:'transport',label:'MCP transport configured',description:'The MCP transport is configured at /mcp on this Engine Host.',ok:engine.transportPath==='/mcp',required:true});
	}

	let apex:any=null;
	if(engine.id==='apex'){
		// Reuse the already-loaded engine state so APEX readiness does not re-read the
		// same add-on, licence and host rows from Supabase.
		apex=await getApexSetupReadiness(engine);
		const processors=listApexProcessorCapabilities();
		const registered=new Set(processors.flatMap((processor:any)=>(processor.extensions||[]).map((extension:string)=>String(extension).replace(/^\./,'').toLowerCase())));
		const missing=[...APEX_SUPPORTED_EXTENSIONS].filter((extension)=>!registered.has(extension));
		checks.push(
			{id:'apex_processing_core',label:'APEX processing core',description:apex.core.initialized?'The shared APEX processing core is initialized.':'Initialize the shared APEX processing core from First-time setup.',ok:apex.core.initialized===true,required:true},
			{id:'apex_processors',label:'Knowledge extraction processors',description:missing.length?`Missing APEX processors for: ${missing.join(', ')}.`:'PDF, DOCX, TXT, Markdown, HTML, CSV and JSON extraction processors are registered.',ok:missing.length===0,required:true},
			{id:'apex_workspace_link',label:'APEX workspace link',description:'The linked Panel workspace exists in the shared OrbitFS backend.',ok:apex.workspaceValid===true,required:true},
			{id:'apex_processing_settings',label:'Knowledge ingest settings',description:apex.workspaceSettings?'Workspace processing defaults are stored and ready for APEX jobs.':'Initialize the APEX core to create workspace processing defaults.',ok:apex.workspaceSettings===true,required:true},
			{id:'apex_library_integration',label:'Library / Knowledge integration',description:apex.libraryIntegration?'The linked workspace Library backend is reachable; Panel Library owns canonical Knowledge.':'The linked workspace Library backend could not be verified.',ok:apex.libraryIntegration===true,required:true},
			{id:'apex_knowledge_architecture',label:'Knowledge Architecture routing',description:apex.knowledgeArchitecture?.setupComplete?'Knowledge Setup is configured and can route active/reference/project Knowledge.':'Knowledge Setup is not complete. APEX ingest still works; automatic Knowledge Architecture placement is optional.',ok:apex.knowledgeArchitecture?.setupComplete===true,required:false},
			{id:'apex_mcp_bridge',label:'MCP Knowledge context bridge',description:apex.mcpIntegration?.installed!==true?'MCP is not installed. APEX → Library remains independent.':apex.mcpIntegration?.ready?'MCP is installed and ready to load APEX-routed Library Knowledge.':'MCP is installed but its APEX/Knowledge context bridge is not currently ready.',ok:apex.mcpIntegration?.ready===true,required:false},
			{id:'apex_serverless_runtime',label:'Serverless processing runtime',description:'APEX uses event-driven Vercel compute with shared Supabase state and no persistent filesystem.',ok:apex.runtime===true,required:true}
		);
	}

	const blocking=checks.filter((check)=>check.required&&!check.ok);
	return {engine,checks,ready:blocking.length===0,blocking:blocking.map((check)=>check.id),apex};
}
