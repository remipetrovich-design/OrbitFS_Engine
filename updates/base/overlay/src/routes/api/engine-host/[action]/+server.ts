import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth';
import { assertPanelLicensed } from '$lib/server/license';
import { isSystemAdmin } from '$lib/server/workspaces';
import { writeAudit } from '$lib/server/audit';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { getSharedEngineHostState, saveSharedEngineHostState } from '$lib/server/engine-host-state';
import { ENGINE_DEPLOYER_PROTOCOL, fetchEngineBootstrapRelease, assertInitialEngineRelease, inspectInstalledEngineDatabase, engineHostProvisioningStatus, provisionSharedEngineHost, refreshSharedEngineDeployment, registerSharedEngineUpdater, deleteRegisteredSharedEngineProject, scopeEngineReleaseForInstalledLicenses, configureSharedEngineDomain, checkSharedEngineVercelDomainAvailability, getSharedEngineDomainDnsInstructions, refreshSharedEngineCustomDomainStatus } from '$lib/server/vercel-engine-provision';
import { confirmSharedEngineHostLink, confirmSharedEngineHostUnlink, readSharedEngineHostLink } from '$lib/server/engine-host-remote';
import { getVercelConnectionSummary } from '$lib/server/vercel-connection';
import { fetchAuthorizedEngineBranch } from '$lib/server/engine-branch-client';
import { fetchLatestEngineRelease } from '$lib/server/engine-release-client';
import { buildEngineUpdatePlan } from '$lib/server/engine-update-planner';
import { resolveInstalledBaseVersion } from '$lib/server/base-release-state';
import { clearEngineActiveRelease } from '$lib/server/update-checkpoints';
import { assertAddonLicensed, CLOUD_ADDON_MANIFESTS, getCloudAddon, saveCloudAddon } from '$lib/server/cloud-addons';
import { getEngineAttachContext } from '$lib/server/engine-host';
import { confirmEngineHostPairing } from '$lib/server/engine-host-remote';
import { syncApexKnowledgeToMcp } from '$lib/server/apex-mcp-integration';

const fail = (error:any) => json({error:String(error?.message||'Shared Engine Host request failed'),code:String(error?.code||'ENGINE_HOST_ERROR')},{status:Number(error?.status||500)});
const fatalLinkCodes = new Set(['INSTALLATION_MISMATCH','PANEL_URL_MISMATCH','ENGINE_HOST_ALREADY_LINKED','ENGINE_HOST_INSTALLATION_MISMATCH','ENGINE_HOST_DEPLOYMENT_MISMATCH']);

async function context(cookies:any) {
	const user=await requireUser(cookies);
	await assertPanelLicensed();
	if(!isSystemAdmin(user)) throw Object.assign(new Error('System Owner or Admin required'),{status:403});
	return user;
}

async function statusPayload(extra:Record<string,unknown>={}) {
	const provisioning=await engineHostProvisioningStatus();
	return {host:await getSharedEngineHostState(),provisioningAvailable:provisioning.available,provisioningMissing:provisioning.missing,vercelConnection:await getVercelConnectionSummary(),provider:'vercel',...extra};
}

async function assertNoAttachedEngines() {
	const db=getSupabaseAdmin();
	const result=await db.from('orbitfs_addons').select('id,name').eq('attached',true).limit(20);
	if(result.error) throw result.error;
	if((result.data||[]).length) {
		const names=(result.data||[]).map((row:any)=>String(row.name||row.id)).join(', ');
		throw Object.assign(new Error(`Detach all engines before unlinking the Shared Engine Host: ${names}`),{status:409,code:'ENGINE_HOST_ENGINES_ATTACHED'});
	}
}

async function autoAttachInstalledEngineAddons(user:any) {
	const db=getSupabaseAdmin();
	const engineIds=Object.keys(CLOUD_ADDON_MANIFESTS).filter((id)=>CLOUD_ADDON_MANIFESTS[id]?.runtimeMode==='engine-host');
	const result=await db.from('orbitfs_addons').select('id,name,installed,attached,configured,available,license_component,status,runtime').in('id',engineIds);
	if(result.error)throw result.error;
	const attached:any[]=[];
	for(const row of result.data||[]){
		const id=String((row as any).id||'').trim().toLowerCase();
		const manifest=CLOUD_ADDON_MANIFESTS[id];
		if(!manifest||manifest.runtimeMode!=='engine-host'||(row as any).available===false)continue;
		const runtime=(row as any).runtime&&typeof (row as any).runtime==='object'?(row as any).runtime:{};
		const pendingInstall=runtime.pendingInstall===true;

		if((row as any).attached===true){
			const setupComplete=(row as any).configured===true&&String(runtime.setupState||'')==='complete';
			if(id==='mcp'&&!setupComplete){
				const component=String((row as any).license_component||manifest.licenseComponent||'').trim();
				await assertAddonLicensed(component||null,false);
				const attach=await getEngineAttachContext(id,String(user.id));
				const remote=await confirmEngineHostPairing({engineId:id,installationId:attach.installationId,panelUrl:attach.panelUrl,workspaceId:attach.workspaceId,actorUserId:String(user.id)});
				const current=await getCloudAddon(id);
				const currentRuntime=current.runtime&&typeof current.runtime==='object'?current.runtime:{};
				await saveCloudAddon(id,{runtime:{...currentRuntime,pendingInstall:false,desiredInstalled:true,installState:'installed',autoAttachPending:false,lastAutoAttachAt:new Date().toISOString(),lastManualDetachAt:null}});
				await writeAudit({actorUserId:user.id,action:'engine.auto_setup_repair',targetType:'addon',targetId:id,detail:{engineHost:true,workspaceId:attach.workspaceId,licenseComponent:component,remoteConfirmed:true}});
				attached.push({id,component,workspaceId:attach.workspaceId,remote,repairedSetup:true});
				continue;
			}
			if(runtime.autoAttachPending===true||pendingInstall){
				await saveCloudAddon(id,{runtime:{...runtime,pendingInstall:false,desiredInstalled:true,autoAttachPending:false,lastAutoAttachAt:new Date().toISOString()}});
			}
			continue;
		}

		// Existing installed components may be auto-attached after a Host rebuild.
		// New components remain installed=false until Engine confirms this signed
		// pairing; pairEngineHost atomically flips installed+attached on success.
		const shouldAttach=pendingInstall||((row as any).installed===true&&(runtime.autoAttachPending===true||!runtime.lastManualDetachAt));
		if(!shouldAttach)continue;

		const component=String((row as any).license_component||manifest.licenseComponent||'').trim();
		try{
			await assertAddonLicensed(component||null,false);
		}catch(error:any){
			const code=String(error?.code||'').trim().toUpperCase();
			const componentOnly=['LICENSE_REQUIRED','LICENSE_COMPONENT_NOT_ENTITLED','COMPONENT_NOT_ENTITLED','ENTITLEMENT_REQUIRED','COMPONENT_NOT_LICENSED'].includes(code);
			if(!componentOnly)throw error;
			const current=await getCloudAddon(id);
			const currentRuntime=current.runtime&&typeof current.runtime==='object'?current.runtime:{};
			await saveCloudAddon(id,{
				attached:false,
				configured:false,
				status:'license_required',
				runtime:{...currentRuntime,pendingInstall:false,online:false,installState:'license_required',lastLicenseReason:code,lastLicenseCheckedAt:new Date().toISOString()}
			});
			attached.push({id,component,skipped:true,reason:code});
			continue;
		}

		const attach=await getEngineAttachContext(id,String(user.id));
		const remote=await confirmEngineHostPairing({engineId:id,installationId:attach.installationId,panelUrl:attach.panelUrl,workspaceId:attach.workspaceId,actorUserId:String(user.id)});
		const current=await getCloudAddon(id);
		const currentRuntime=current.runtime&&typeof current.runtime==='object'?current.runtime:{};
		await saveCloudAddon(id,{
			installed:true,
			attached:true,
			status:'attached',
			installed_at:(current as any).installed_at||new Date().toISOString(),
			runtime:{...currentRuntime,pendingInstall:false,desiredInstalled:true,installState:'installed',autoAttachPending:false,lastAutoAttachAt:new Date().toISOString(),lastManualDetachAt:null}
		});
		let knowledgeSync:any=null;
		if(id==='mcp'||id==='apex'){
			knowledgeSync=await syncApexKnowledgeToMcp(attach.workspaceId).catch((error:any)=>({available:true,synced:0,failed:1,error:String(error?.message||error||'Knowledge reconciliation failed')}));
		}
		await writeAudit({actorUserId:user.id,action:pendingInstall?'addon.install.complete':'engine.auto_attach',targetType:'addon',targetId:id,detail:{engineHost:true,workspaceId:attach.workspaceId,licenseComponent:component,remoteConfirmed:true,pendingInstall}});
		attached.push({id,component,workspaceId:attach.workspaceId,remote,knowledgeSync,pendingInstall});
	}
	return attached;
}

async function advanceProvisionedHost(user:any, body:Record<string,any>={}) {
	let current=await getSharedEngineHostState();
	let deployment:any=null;
	if((current.pendingDeploymentId||current.deploymentId) && (!['linked','ready'].includes(current.state) || current.updaterConnected!==true || Boolean(current.pendingDeploymentId) || Boolean(current.pendingReleaseInventory?.length))) {
		deployment=await refreshSharedEngineDeployment(body);
		current=deployment.host;
		if(!deployment.ready) return {waiting:true,phase:'deploying',readyState:deployment.readyState,remote:null};
	}
	if(!current.hostUrl) throw Object.assign(new Error('Deploy the Shared Engine Host before linking it.'),{status:409,code:'ENGINE_HOST_NOT_DEPLOYED'});

	if(['linked','ready'].includes(current.state)) {
		try {
			const remote=await readSharedEngineHostLink();
			await saveSharedEngineHostState({state:'ready',lastHealthAt:new Date().toISOString(),lastSyncAt:new Date().toISOString(),lastError:null});
			const autoAttached=await autoAttachInstalledEngineAddons(user);
			return {waiting:false,phase:'ready',readyState:deployment?.readyState||'READY',remote,autoAttached};
		} catch(error:any) {
			const code=String(error?.code||'');
			if(fatalLinkCodes.has(code)) {
				await saveSharedEngineHostState({state:'error',lastError:String(error?.message||'Shared Engine Host verification failed')}).catch(()=>undefined);
				throw error;
			}
			await saveSharedEngineHostState({
				state:'deployed',
				lastSyncAt:new Date().toISOString(),
				lastError:`Engine deployment is ready; waiting for Host startup: ${String(error?.message||'not reachable yet')}`
			});
			return {waiting:true,phase:'starting',readyState:deployment?.readyState||'READY',remote:null};
		}
	}

	await saveSharedEngineHostState({state:'linking',lastError:null});
	try {
		const remote=await confirmSharedEngineHostLink({installationId:current.installationId,panelUrl:String(current.panelUrl||''),actorUserId:String(user.id)});
		await saveSharedEngineHostState({state:'ready',lastHealthAt:new Date().toISOString(),lastSyncAt:new Date().toISOString(),lastError:null});
		const autoAttached=await autoAttachInstalledEngineAddons(user);
		return {waiting:false,phase:'ready',readyState:deployment?.readyState||'READY',remote,autoAttached};
	} catch(error:any) {
		const code=String(error?.code||'');
		if(fatalLinkCodes.has(code)) {
			await saveSharedEngineHostState({state:'error',lastError:String(error?.message||'Shared Engine Host linking failed')}).catch(()=>undefined);
			throw error;
		}
		await saveSharedEngineHostState({state:'deployed',lastSyncAt:new Date().toISOString(),lastError:`Engine deployment is ready; waiting for Host startup: ${String(error?.message||'not reachable yet')}`});
		return {waiting:true,phase:'starting',readyState:deployment?.readyState||'READY',remote:null};
	}
}

export async function GET({params,cookies}:any) {
	try {
		await context(cookies);
		const action=String(params.action||'').trim().toLowerCase();
		if(action==='domain-dns') {
			return json({ok:true,dns:await getSharedEngineDomainDnsInstructions()},{headers:{'cache-control':'private, no-store'}});
		}
		return json({error:'Engine Host action not found',code:'ENGINE_HOST_ACTION_NOT_FOUND'},{status:404});
	}catch(error){return fail(error);}
}

export async function POST({params,request,cookies}:any) {
	try {
		const user=await context(cookies);
		const action=String(params.action||'').trim().toLowerCase();
		const body=await request.json().catch(()=>({}));

		if(action==='database-status') {
			return json({ok:true,database:await inspectInstalledEngineDatabase()});
		}
		if(action==='database-repair') {
			const before=await inspectInstalledEngineDatabase();
			if(!before.repairSupported) throw Object.assign(new Error('Install or update the Engine through its approved deployment workflow first.'),{status:409,code:'ENGINE_DB_UPDATE_REQUIRED'});
			if(!before.missing.length) return json({ok:true,database:before,applied:[],noOp:true});
			// Never run SQL independently of the approved package and the normal
			// checkpointed Engine update path.
			const result=await provisionSharedEngineHost({...body,releaseId:before.releaseId,actorUserId:user.id,actorUsername:user.username});
			const after=await inspectInstalledEngineDatabase();
			if(after.status!=='current') throw Object.assign(new Error('Engine database migration verification is incomplete.'),{status:503,code:'ENGINE_DB_REPAIR_VERIFY_FAILED'});
			await writeAudit({actorUserId:user.id,action:'engine_host.database_repair',targetType:'engine_host',targetId:before.releaseId,detail:{applied:result.databaseMigrations||[],sourceCommit:before.sourceCommit}});
			return json({ok:true,database:after,applied:result.databaseMigrations||[],noOp:'noOp' in result && Boolean(result.noOp)});
		}

		if(action==='plan') {
			const current=await getSharedEngineHostState();
			const installedBaseVersion=await resolveInstalledBaseVersion();
			if(!current.releaseId&&!current.deploymentId&&!current.pendingDeploymentId){
				const bootstrap=await fetchEngineBootstrapRelease();
				assertInitialEngineRelease(bootstrap);
				const scoped=(await scopeEngineReleaseForInstalledLicenses(bootstrap,body.components)).release;
				let plan=await buildEngineUpdatePlan({descriptor:scoped.descriptor,package:scoped.package,installedBaseVersion,supportedProtocol:ENGINE_DEPLOYER_PROTOCOL});
				if(scoped.descriptor.requiresPanelUpdate&&String(env.ORBITFS_UPDATE_RELEASE_ID||'').trim()!==scoped.descriptor.releaseId){
					plan={...plan,status:'blocked',blocked:true,reason:'This release also changes Base. Apply the combined approved update before deploying Engine.'};
				}
				return json({ok:true,plan,release:{version:scoped.descriptor.version,id:scoped.descriptor.releaseId,channel:scoped.descriptor.channel,checksum:scoped.descriptor.sha256,components:scoped.descriptor.components,source:'license-manager'}});
			}
			const releaseSource=current.distribution==='orbitfs-store-package-v1'?'published-update':'authorized-branch';
			const authorized=releaseSource==='published-update'
				?await fetchLatestEngineRelease({channel:current.releaseChannel||'stable'})
				:await fetchAuthorizedEngineBranch();
			const release=(await scopeEngineReleaseForInstalledLicenses(authorized,body.components)).release;
			let plan=await buildEngineUpdatePlan({descriptor:release.descriptor,package:release.package,installedBaseVersion,supportedProtocol:ENGINE_DEPLOYER_PROTOCOL});
			if(release.descriptor.requiresPanelUpdate&&String(env.ORBITFS_UPDATE_RELEASE_ID||'').trim()!==release.descriptor.releaseId){
				plan={...plan,status:'blocked',blocked:true,reason:`Update ${release.descriptor.version} also changes OrbitFS Base. Apply the full Update release through the customer update system before updating the Shared Engine.`};
			}
			return json({ok:true,plan,release:{version:release.descriptor.version,id:release.descriptor.releaseId,channel:release.descriptor.channel,checksum:release.descriptor.sha256,components:release.descriptor.components,source:releaseSource}});
		}

		if(action==='provision') {
			body.actorUserId=user.id;
			body.actorUsername=user.username;
			const provisioned=await provisionSharedEngineHost(body);
			const advanced=await advanceProvisionedHost(user,body);
			await writeAudit({actorUserId:user.id,action:'engine_host.provision',targetType:'engine_host',targetId:provisioned.projectId||provisioned.installationId,detail:{provider:'vercel',projectName:provisioned.projectName,hostUrl:provisioned.hostUrl,automaticLink:true,phase:advanced.phase,updatePlan:provisioned.updatePlan||null}});
			return json({ok:true,...advanced,...await statusPayload()});
		}

		if(action==='link') {
			const advanced=await advanceProvisionedHost(user,body);
			if(!advanced.waiting) {
				const current=await getSharedEngineHostState();
				await writeAudit({actorUserId:user.id,action:'engine_host.link',targetType:'engine_host',targetId:current.installationId,detail:{hostUrl:current.hostUrl,remoteConfirmed:true,automatic:false}});
			}
			return json({ok:true,...advanced,...await statusPayload()});
		}

		if(action==='refresh') {
			const current=await getSharedEngineHostState();
			if(!current.hostUrl && !current.deploymentId) return json({ok:true,waiting:false,phase:'not_deployed',...await statusPayload()});
			const advanced=await advanceProvisionedHost(user,body);
			return json({ok:true,...advanced,...await statusPayload()});
		}
		if(action==='domain-refresh') {
			const result=await refreshSharedEngineCustomDomainStatus();
			await writeAudit({actorUserId:user.id,action:'engine_host.domain_refresh',targetType:'engine_host',targetId:String(result.host.projectId||''),detail:{domain:result.dns?.domain||null,verified:result.dns?.ready===true}});
			return json({ok:true,dns:result.dns,...await statusPayload({host:result.host})},{headers:{'cache-control':'private, no-store'}});
		}
		if(action==='domain-check') {
			const availability=await checkSharedEngineVercelDomainAvailability(body);
			await writeAudit({actorUserId:user.id,action:'engine_host.domain_check',targetType:'engine_host',targetId:String((await getSharedEngineHostState()).projectId||''),detail:{domain:availability.domain,available:availability.available,reserved:availability.reserved}});
			return json({ok:true,availability,...await statusPayload()});
		}
		if(action==='domain') {
			const result=await configureSharedEngineDomain(body);
			await writeAudit({
				actorUserId:user.id,
				action:'engine_host.domain_update',
				targetType:'engine_host',
				targetId:String(result.host.projectId||result.host.installationId),
				detail:{mode:result.domain.mode,vercelDomain:result.domain.vercelDomain||null,customDomain:result.domain.customDomain||null,verified:result.domain.verified,effectiveUrl:result.domain.effectiveUrl}
			});
			return json({ok:true,domain:result.domain,...await statusPayload({host:result.host})});
		}

		if(action==='register'||action==='sync-updater') {
			body.actorUserId=user.id;
			body.actorUsername=user.username;
			const result=await registerSharedEngineUpdater(body);
			const waiting=result.updateStarted===true && ['provisioning','deployed','linking'].includes(String((result.host as any)?.state||''));
			await writeAudit({
				actorUserId:user.id,
				action:'engine_host.updater_sync',
				targetType:'engine_host',
				targetId:String((result.host as any)?.installationId||''),
				detail:{synced:result.synced,conflict:result.conflict,updateStarted:result.updateStarted||false,latestVersion:(result.latest as any)?.version||null,latestReleaseId:(result.latest as any)?.releaseId||null}
			});
			return json({ok:true,waiting,updaterSync:result,...await statusPayload()},{status:waiting?202:200});
		}


		if(action==='uninstall') {
			const current=await getSharedEngineHostState(true);
			const expected=String(body.confirmProjectName||'').trim();
			const projectId=String(current.projectId||'').trim();
			if(!projectId || !current.projectName) throw Object.assign(new Error('There is no registered Shared Engine project to uninstall.'),{status:409,code:'ENGINE_NOT_INSTALLED'});
			if(expected!==current.projectName || String(body.confirmProjectId||'')!==projectId || body.preserveDatabase!==true) {
				throw Object.assign(new Error('Confirm the exact Engine project name and identity and acknowledge that customer Supabase data will be preserved.'),{status:400,code:'ENGINE_UNINSTALL_CONFIRMATION_REQUIRED'});
			}
			await assertNoAttachedEngines();
			const deletion=await deleteRegisteredSharedEngineProject(projectId);
			// Park any still-installed but detached addons. Do not silently
			// reattach them when a new Engine is installed later.
			const installed=await getSupabaseAdmin().from('orbitfs_addons').select('id,runtime').eq('installed',true).eq('attached',false);
			if(installed.error)throw installed.error;
			for(const row of installed.data||[]){
				const id=String(row.id||'').trim().toLowerCase();
				if(CLOUD_ADDON_MANIFESTS[id]?.runtimeMode!=='engine-host')continue;
				await saveCloudAddon(id,{runtime:{...(row.runtime||{}),online:false,autoAttachPending:false,lastManualDetachAt:new Date().toISOString()}});
			}
			// From this point the project is verified gone. Persist local cleanup
			// sequentially; a retry is safe if a previous cleanup failed.
			await clearEngineActiveRelease(current.releaseId);
			const host=await saveSharedEngineHostState({
				state:'not_deployed',
				hostUrl:null,projectId:null,projectName:null,deploymentId:null,deploymentUrl:null,
				distribution:null,releaseVersion:null,releaseId:null,releaseChannel:null,
				releaseSha256:null,releaseSourceCommit:null,releaseFileCount:null,
				pendingDeploymentId:null,pendingDeploymentUrl:null,pendingReleaseVersion:null,
				pendingReleaseId:null,pendingReleaseChannel:null,pendingReleaseSha256:null,
				pendingReleaseSourceCommit:null,pendingReleaseFileCount:null,pendingReleaseInventory:null,
				pendingReleaseComponents:[],pendingReleaseComponentVersions:{},
				updaterConnected:false,updaterConnectedAt:null,updaterProvider:null,
				updaterProtocol:null,updaterLastVerifiedAt:null,updaterLastError:null,
				linkedAt:null,linkedByUserId:null,lastSyncAt:new Date().toISOString(),
				lastHealthAt:null,lastError:null
			},current);
			await writeAudit({
				actorUserId:user.id,action:'engine_host.uninstall',targetType:'engine_host',
				targetId:projectId,detail:{projectName:current.projectName,releaseId:current.releaseId,
				vercelProjectDeleted:true,previouslyAbsent:deletion.alreadyAbsent,
				customerDatabasePreserved:true,addonDataPreserved:true}
			});
			return json({ok:true,projectDeleted:true,preservedDatabase:true,preservedAddonData:true,...await statusPayload({host})});
		}

		if(action==='unlink') {
			await assertNoAttachedEngines();
			const current=await getSharedEngineHostState();
			let remoteConfirmed=false;
			if(current.hostUrl&&['linked','ready','error'].includes(current.state)) {
				try {
					await confirmSharedEngineHostUnlink(current.installationId,String(user.id));
					remoteConfirmed=true;
				} catch(error:any) {
					const code=String(error?.code||'');
					const status=Number(error?.status||error?.engineStatus||0);
					const remoteUnavailable=code==='ENGINE_HOST_REQUEST_FAILED'||status>=500||(!code&&!status&&error instanceof TypeError);
					if(!remoteUnavailable)throw error;
				}
			}
			const host=await saveSharedEngineHostState({
				state:current.hostUrl?'deployed':'not_deployed',
				linkedAt:null,
				linkedByUserId:null,
				updaterConnected:false,
				updaterLastError:current.hostUrl?'Shared Engine Host is deployed but is not linked to this Panel.':null,
				lastSyncAt:new Date().toISOString(),
				lastError:null
			});
			await writeAudit({actorUserId:user.id,action:'engine_host.unlink',targetType:'engine_host',targetId:current.installationId,detail:{hostUrl:current.hostUrl,remoteConfirmed,localFallback:!remoteConfirmed}});
			return json({ok:true,...await statusPayload({host})});
		}

		throw Object.assign(new Error('Not found'),{status:404});
	} catch(error) {
		return fail(error);
	}
}