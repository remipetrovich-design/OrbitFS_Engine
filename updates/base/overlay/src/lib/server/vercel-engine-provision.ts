import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { configuredPanelUrl, getSharedEngineHostState, normalizeDomainHost, saveSharedEngineHostState } from '$lib/server/engine-host-state';
import { fetchLatestEngineRelease, verifyEngineUpdaterRelease } from '$lib/server/engine-release-client';
import { fetchAuthorizedEngineBranch, verifyAuthorizedEngineBranch } from '$lib/server/engine-branch-client';
import { getVercelCredentials } from '$lib/server/vercel-connection';
import { describeEngineDomainDns } from '$lib/server/engine-domain-dns';
import { buildEngineUpdatePlan } from '$lib/server/engine-update-planner';
import { createUpdateCheckpoint, getActiveRelease, setEngineActiveRelease } from '$lib/server/update-checkpoints';
import { getLicenseProviderSettings, recordLicenseManagerCheckIn } from '$lib/server/license';
import { getInstallationRoute } from '$lib/server/setup';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { engineDatabaseCredentials, engineSharedSecret } from '$lib/server/runtime-secrets';
import { resolveInstalledBaseVersion } from '$lib/server/base-release-state';
import { resolveUpdaterProviderBase } from '$lib/server/updater-connection';
import { assertAddonLicensed, CLOUD_ADDON_MANIFESTS, prepareInstalledEngineAddonLicenses, engineHostBootstrapEntitlement } from '$lib/server/cloud-addons';
import { fetchEngineDatabasePackageSet } from '$lib/server/database-package-registry';

const API = 'https://api.vercel.com';
export const ENGINE_DEPLOYER_PROTOCOL = 1;
const ENGINE_COMPONENT_IDS=['apex','mcp','studio'] as const;

function normalizeExecutionComponents(value:unknown,available:string[]){
	const availableSet=new Set(available.map((item)=>String(item||'').trim().toLowerCase()).filter((item)=>ENGINE_COMPONENT_IDS.includes(item as any)));
	if(!Array.isArray(value)) return [...availableSet];
	const requested=[...new Set(value.map((item)=>String(item||'').trim().toLowerCase()).filter(Boolean))];
	const invalid=requested.filter((item)=>!ENGINE_COMPONENT_IDS.includes(item as any));
	if(invalid.length) throw fail('Unsupported Engine update component(s): '+invalid.join(', '),400,'ENGINE_UPDATE_COMPONENT_INVALID');
	if(!requested.length) throw fail('At least one Engine update component is required.',400,'ENGINE_UPDATE_COMPONENT_REQUIRED');
	const selected=requested.filter((item)=>availableSet.has(item));
	if(!selected.length) throw fail('This Engine release has no payload for the requested component set.',409,'ENGINE_UPDATE_NOT_APPLICABLE');
	return selected;
}

export function scopeEngineReleaseForExecution(release:any,requested:unknown){
	const available:string[]=[...new Set<string>((release?.descriptor?.components||release?.package?.components||[]).map((item:any)=>String(item||'').trim().toLowerCase()).filter((item:string)=>ENGINE_COMPONENT_IDS.includes(item as any)))];
	const components=normalizeExecutionComponents(requested,available);
	const selected=new Set(components);
	const rawVersions=release?.package?.componentVersions&&typeof release.package.componentVersions==='object'?release.package.componentVersions:{};
	const componentVersions=Object.fromEntries(Object.entries(rawVersions).filter(([key])=>selected.has(String(key).toLowerCase())));
	const database=release?.package?.database&&typeof release.package.database==='object'?release.package.database:null;
	const migrations=Array.isArray(database?.migrations)?database.migrations.filter((migration:any)=>{
		const component=String(migration?.component||'').trim().toLowerCase();
		return component==='shared'||selected.has(component);
	}):[];
	const scopedDatabase=database?{...database,migrations,migrationCount:migrations.length}:database;
	return {
		...release,
		descriptor:{...release.descriptor,components},
		package:{...release.package,components,componentVersions,...(scopedDatabase?{database:scopedDatabase,databaseMigrationCount:migrations.length}:{})},
		executionComponents:components
	};
}

export async function scopeEngineReleaseForInstalledLicenses(release:any,requested:unknown){
	const preparedAddons=await prepareInstalledEngineAddonLicenses();
	const installedAuthorized=[...new Set(preparedAddons
		.filter((addon)=>addon.status==='locked'&&addon.lockedToThisInstallation===true)
		.map((addon)=>String(addon.id||'').trim().toLowerCase())
		.filter((component)=>ENGINE_COMPONENT_IDS.includes(component as any)))];
	const explicitRequested=Array.isArray(requested)
		?[...new Set(requested.map((item:any)=>String(item||'').trim().toLowerCase()).filter(Boolean))]
		:[];
	const unsupported=explicitRequested.filter((component)=>!ENGINE_COMPONENT_IDS.includes(component as any));
	if(unsupported.length)throw fail('Unsupported Engine update component(s): '+unsupported.join(', '),400,'ENGINE_UPDATE_COMPONENT_INVALID');

	// A newly requested component may be provisioned before its local installed
	// flag is set, but only after License Manager has already locked that exact
	// component to this installation. This breaks the old installed->deploy loop
	// without trusting the client request as authorization.
	const requestedAuthorized:string[]=[];
	for(const component of explicitRequested){
		if(installedAuthorized.includes(component)){
			requestedAuthorized.push(component);
			continue;
		}
		const manifest=CLOUD_ADDON_MANIFESTS[component];
		const licenseComponent=String(manifest?.licenseComponent||'').trim();
		if(!licenseComponent)throw fail('Unknown Engine component authorization mapping: '+component,400,'ENGINE_COMPONENT_AUTHORIZATION_INVALID');
		try{
			await assertAddonLicensed(licenseComponent,false);
			requestedAuthorized.push(component);
		}catch(error:any){
			throw fail(
				'This installation is not licensed and locked for Engine component(s): '+component,
				Number(error?.status||403),
				'ENGINE_COMPONENT_NOT_AUTHORIZED'
			);
		}
	}

	let targetComponents=[...new Set([
		...installedAuthorized,
		...(explicitRequested.length?requestedAuthorized:[])
	])];

	// First Shared Engine deployment happens before plugin installation. If no
	// plugin is installed yet, use one authoritative add-on entitlement only as
	// the bootstrap authorization for the shared runtime. This does NOT mark the
	// add-on installed or attached.
	if(!targetComponents.length&&!explicitRequested.length){
		const bootstrap=await engineHostBootstrapEntitlement({activate:true,refresh:true});
		if(!bootstrap.eligible||!bootstrap.componentId){
			throw fail('At least one active OrbitFS add-on licence is required before deploying the Shared Engine Host.',403,'ENGINE_ADDON_LICENSE_REQUIRED');
		}
		targetComponents=[bootstrap.componentId];
	}
	if(!targetComponents.length){
		throw fail('At least one active OrbitFS add-on licence is required before deploying the Shared Engine Host.',403,'ENGINE_ADDON_LICENSE_REQUIRED');
	}
	return {
		release:scopeEngineReleaseForExecution(release,targetComponents),
		preparedAddons,
		authorizedComponents:targetComponents
	};
}

// The inner deployer is independent from website Update release publication.
// Custom License Manager authenticates the installation and retrieves the pinned branch.
export async function fetchEngineBootstrapRelease(_channel?: string | null) {
  return fetchAuthorizedEngineBranch();
}

export function assertInitialEngineRelease(release: any) {
  const components=[...new Set((release?.descriptor?.components||[]).map((item:any)=>String(item).toLowerCase()).filter((item:string)=>ENGINE_COMPONENT_IDS.includes(item as any)))];
  if(!components.length) throw fail('Initial Engine install requires at least one authorized Engine component.',409,'ENGINE_BOOTSTRAP_BASELINE_INCOMPLETE');
}

function fail(message: string, status = 500, code = 'ENGINE_HOST_PROVISION_FAILED') {
	return Object.assign(new Error(message), { status, code });
}

function authorityUnavailable(error: any) {
	const status = Number(error?.status || 0);
	const code = String(error?.code || '').trim().toUpperCase();
	if (status === 401 || status === 403 || status === 409) return false;
	if (status >= 500 || status === 0) return true;
	if (['LICENSE_MASTER_ERROR', 'UPDATER_ERROR', 'RELEASE_CHECK_FAILED'].includes(code)) return true;
	return error?.name === 'AbortError' || error instanceof TypeError;
}

async function credentialsFrom(input: Record<string, any> = {}) {
	const requestToken = String(input.vercelToken || '').trim();
	const requestTeam = String(input.teamId || '').trim();
	if (requestToken) return { token: requestToken, teamId: requestTeam };

	const stored = await getVercelCredentials();
	if (stored?.token) return { token: stored.token, teamId: String(stored.teamId || '').trim() };

	const fallbackToken = String(env.ORBITFS_VERCEL_TOKEN || env.VERCEL_API_TOKEN || '').trim();
	const fallbackTeam = String(env.ORBITFS_VERCEL_TEAM_ID || env.VERCEL_ORG_ID || '').trim();
	return { token: fallbackToken, teamId: fallbackTeam };
}

function projectName(installationId: string) {
	const prefix = String(env.ORBITFS_ENGINE_PROJECT_PREFIX || 'orbitfs-engine').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'orbitfs-engine';
	const suffix = installationId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'host';
	return `${prefix}-${suffix}`.slice(0, 100);
}

function requestUrl(path: string, teamId: string, extra: Record<string, string> = {}) {
	const url = new URL(path, API);
	if (teamId) url.searchParams.set('teamId', teamId);
	for (const [key, value] of Object.entries(extra)) if (value) url.searchParams.set(key, value);
	return url;
}

async function vercelRequest(path: string, token: string, teamId: string, init: RequestInit = {}, extra: Record<string, string> = {}) {
	const response = await fetch(requestUrl(path, teamId, extra), {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			...(init.body ? { 'content-type': 'application/json' } : {}),
			...(init.headers || {})
		},
		cache: 'no-store',
		signal: AbortSignal.timeout(Math.max(8_000, Number(env.ORBITFS_VERCEL_TIMEOUT_MS || 30_000)))
	});
	const body: any = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw fail(String(body?.error?.message || body?.message || `Vercel returned ${response.status}`), response.status < 500 ? response.status : 503, String(body?.error?.code || 'VERCEL_API_FAILED'));
	}
	return body;
}


async function upsertProjectEnvironment(projectId:string, variables:Array<{key:string;value:string;type:string;target:string[]}>, token:string, teamId:string) {
	for(const item of variables){
		await vercelRequest(`/v10/projects/${encodeURIComponent(projectId)}/env`,token,teamId,{
			method:'POST',
			body:JSON.stringify(item)
		},{upsert:'true'});
	}
}

async function removeProjectEnvironmentKeys(projectId:string, keys:string[], token:string, teamId:string) {
	if(!keys.length)return;
	let payload:any=null;
	let apiVersion='v10';
	for(const version of ['v10','v9']){
		try{
			payload=await vercelRequest(`/${version}/projects/${encodeURIComponent(projectId)}/env`,token,teamId);
			apiVersion=version;
			break;
		}catch(error:any){
			if(Number(error?.status||0)===404)continue;
			throw error;
		}
	}
	if(!payload)return;
	const envs=Array.isArray(payload?.envs)?payload.envs:Array.isArray(payload)?payload:[];
	const remove=new Set(keys);
	for(const item of envs){
		if(!remove.has(String(item?.key||''))||!item?.id)continue;
		await vercelRequest(`/${apiVersion}/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(String(item.id))}`,token,teamId,{method:'DELETE'});
	}
}

// Explicit administrator-requested deletion. Only the registered Engine project
// can be removed; no supplied project ID or destructive DB cleanup is accepted.
export async function deleteRegisteredSharedEngineProject(expectedProjectId: string) {
	const current = await getSharedEngineHostState(true);
	const projectId=String(current.projectId||'').trim();
	const registeredName=String(current.projectName||'').trim();
	if(!projectId || projectId!==String(expectedProjectId||'').trim() || !registeredName) {
		throw fail('Shared Engine project identity changed. Refresh and confirm the currently registered project.',409,'ENGINE_UNINSTALL_PROJECT_MISMATCH');
	}
	if(current.pendingDeploymentId || current.pendingReleaseId) {
		throw fail('An Engine deployment is still pending. Finish or resolve it before deleting the project.',409,'ENGINE_UNINSTALL_DEPLOYMENT_PENDING');
	}
	const {token,teamId}=await credentialsFrom();
	if(!token)throw fail('Connect the owning Vercel account before deleting the Shared Engine project.',409,'VERCEL_TOKEN_REQUIRED');
	const url=`/v9/projects/${encodeURIComponent(projectId)}`;
	let remote:any;
	try {
		remote=await vercelRequest(url,token,teamId);
	} catch(error:any) {
		// A previously attempted delete may have succeeded before local state
		// was reset. Only permit retry if the registered identity still matches.
		if(Number(error?.status)===404)return{projectId,projectName:registeredName,alreadyAbsent:true};
		throw error;
	}
	if(String(remote?.id||'')!==projectId || String(remote?.name||'')!==registeredName){
		throw fail('Vercel returned a different project. No project was deleted.',409,'ENGINE_UNINSTALL_REMOTE_IDENTITY_MISMATCH');
	}
	await vercelRequest(url,token,teamId,{method:'DELETE'});
	// A successful DELETE response is not enough to claim the project vanished.
	try{
		const stillPresent=await vercelRequest(url,token,teamId);
		if(stillPresent)throw fail('Vercel has not confirmed the Engine project deletion. Local state was preserved.',503,'ENGINE_UNINSTALL_NOT_CONFIRMED');
	}catch(error:any){
		if(Number(error?.status)!==404)throw error;
	}
	return{projectId,projectName:registeredName,alreadyAbsent:false};
}

async function sharedEngineProjectDomains(projectId:string,token:string,teamId:string){
	const result=await vercelRequest(`/v9/projects/${encodeURIComponent(projectId)}/domains`,token,teamId);
	return Array.isArray(result?.domains)?result.domains:[];
}

/** Read exact Vercel-recommended DNS targets and TXT ownership challenges for the installed Engine. */
export async function getSharedEngineDomainDnsInstructions() {
	const current=await getSharedEngineHostState(true);
	if(current.domainMode!=='custom'||!current.domainName)return null;
	const projectId=String(current.projectId||'').trim();
	if(!projectId)throw fail('The Shared Engine project is not installed.',409,'ENGINE_HOST_NOT_DEPLOYED');
	const {token,teamId}=await credentialsFrom();
	if(!token)throw fail('Connect the owning Vercel account to read DNS records.',409,'VERCEL_TOKEN_REQUIRED');
	const domain=normalizeDomainHost(current.domainName,'Engine custom domain');
	const domains=await sharedEngineProjectDomains(projectId,token,teamId);
	const entry=domains.find((item:any)=>String(item?.name||'').toLowerCase()===domain);
	if(!entry)throw fail('The configured custom domain is not attached to the Shared Engine Vercel project.',409,'ENGINE_DOMAIN_NOT_ATTACHED');
	const config=await vercelRequest(`/v6/domains/${encodeURIComponent(domain)}/config`,token,teamId,{}, {projectIdOrName:projectId});
	return describeEngineDomainDns(domain,entry,config);
}

/** Only a verified Vercel domain with correct routing DNS may become the active Engine URL. */
export async function refreshSharedEngineCustomDomainStatus() {
	const current=await getSharedEngineHostState(true);
	if(current.domainMode!=='custom'||!current.domainName)return {host:current,dns:null};
	const projectId=String(current.projectId||'').trim();
	const domain=normalizeDomainHost(current.domainName,'Engine custom domain');
	const {token,teamId}=await credentialsFrom();
	if(!token)throw fail('Connect the owning Vercel account to verify DNS records.',409,'VERCEL_TOKEN_REQUIRED');
	let dns=await getSharedEngineDomainDnsInstructions();
	let verificationError:string|null=null;
	if(dns&&!dns.ownershipVerified) {
		try {
			await vercelRequest(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}/verify`,token,teamId,{method:'POST'});
		} catch(error:any) {
			if(![400,404,409].includes(Number(error?.status||0)))throw error;
			verificationError=String(error?.message||'DNS ownership verification is still pending.');
		}
		dns=await getSharedEngineDomainDnsInstructions();
	}
	if(!dns)throw fail('The custom domain DNS status is unavailable.',503,'ENGINE_DOMAIN_DNS_UNKNOWN');
	const verified=dns.ready===true;
	const generatedDomain=`${String(current.projectName||'').toLowerCase()}.vercel.app`;
	const effectiveUrl=verified?`https://${domain}`:`https://${generatedDomain}`;
	let host=current;
	if(verified!==current.domainVerified||current.hostUrl!==effectiveUrl) {
		host=await saveSharedEngineHostState({
			domainVerified:verified,hostUrl:effectiveUrl,lastSyncAt:new Date().toISOString(),
			lastError:verified?null:'Custom Engine domain is waiting for Vercel DNS verification.'
		},current);
		await recordLicenseManagerCheckIn({
			action:'check_in',phase:'completed',product:'orbitfs_base',
			productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
			releaseId:current.releaseId,deploymentId:current.deploymentId,deploymentUrl:host.hostUrl,
			projectId:current.projectId,projectName:current.projectName,
			details:{deploymentProduct:'orbitfs_engine',engineHostUrl:host.hostUrl,mcpUrl:host.hostUrl?`${host.hostUrl}/mcp`:null,domainMode:'custom',domainName:domain,domainVerified:verified}
		});
	}
	return {host,dns:{...dns,verificationError}};
}

function normalizeEngineVercelAlias(value:unknown){
	const raw=String(value||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');
	const candidate=raw.endsWith('.vercel.app')?raw:`${raw}.vercel.app`;
	const domain=normalizeDomainHost(candidate,'Engine Vercel address');
	const slug=domain.slice(0,-'.vercel.app'.length);
	if(!domain.endsWith('.vercel.app')||!slug||slug.includes('.')||slug.length>63||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)){
		throw fail('Enter a valid Vercel address such as my-orbitfs-engine.vercel.app.',400,'ENGINE_VERCEL_ALIAS_INVALID');
	}
	return domain;
}

function vercelAliasUnavailable(error:any){
	const message=String(error?.message||'').toLowerCase();
	return /alias.*(already|in use)|already.*(used|assigned|exists)|domain.*(in use|assigned)|alias_in_use|forbidden.*alias/.test(message);
}

async function ensureSelectedEngineVercelAliasOnDeployment(state:any,deploymentId:string,token:string,teamId:string){
	if(String(state?.domainMode||'')!=='vercel'||!state?.domainName)return;
	const domain=normalizeEngineVercelAlias(state.domainName);
	const projectId=String(state.projectId||'').trim();
	if(!projectId)throw fail('Engine project identity is missing while restoring its Vercel address.',409,'ENGINE_DOMAIN_PROJECT_REQUIRED');
	let current:any=null;
	try{current=await vercelRequest(`/v4/aliases/${encodeURIComponent(domain)}`,token,teamId);}catch(error:any){if(Number(error?.status||0)!==404)throw error;}
	const currentDeploymentId=String(current?.deploymentId||current?.deployment?.id||'').trim();
	const currentProjectId=String(current?.projectId||current?.project?.id||current?.deployment?.projectId||'').trim();
	if(currentDeploymentId===deploymentId&&(!currentProjectId||currentProjectId===projectId))return;
	try{
		// Vercel atomically moves an existing alias from the previous deployment
		// when it is assigned to a new deployment owned by the same account/team.
		await vercelRequest(`/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`,token,teamId,{method:'POST',body:JSON.stringify({alias:domain,redirect:null})});
	}catch(error:any){
		if(vercelAliasUnavailable(error))throw fail(`${domain} could not be moved to the new Engine deployment.`,409,'ENGINE_VERCEL_ALIAS_REBIND_FAILED');
		throw error;
	}
	const verified=await vercelRequest(`/v4/aliases/${encodeURIComponent(domain)}`,token,teamId);
	const verifiedDeploymentId=String(verified?.deploymentId||verified?.deployment?.id||'').trim();
	const verifiedProjectId=String(verified?.projectId||verified?.project?.id||verified?.deployment?.projectId||'').trim();
	if(verifiedDeploymentId!==deploymentId||(verifiedProjectId&&verifiedProjectId!==projectId)){
		throw fail('Vercel did not bind the selected Engine address to the new production deployment.',503,'ENGINE_VERCEL_ALIAS_REBIND_FAILED');
	}
}

export async function checkSharedEngineVercelDomainAvailability(input:Record<string,any>={}){
	const current=await getSharedEngineHostState(true);
	const projectId=String(current.projectId||'').trim();
	const projectName=String(current.projectName||'').trim();
	if(!projectId||!projectName)throw fail('Deploy the Shared Engine before configuring its domain.',409,'ENGINE_HOST_NOT_DEPLOYED');
	const {token,teamId}=await credentialsFrom(input);
	if(!token)throw fail('Connect the owning Vercel account before checking an Engine address.',409,'VERCEL_TOKEN_REQUIRED');
	const domain=normalizeEngineVercelAlias(input.domain);
	const generatedDomain=`${projectName.toLowerCase()}.vercel.app`;
	if(domain===generatedDomain)return {domain,available:true,attached:true,reserved:true,current:true};
	try{
		const alias=await vercelRequest(`/v4/aliases/${encodeURIComponent(domain)}`,token,teamId);
		const aliasProjectId=String(alias?.projectId||alias?.project?.id||alias?.deployment?.projectId||'').trim();
		const aliasDeploymentId=String(alias?.deploymentId||alias?.deployment?.id||'').trim();
		if(aliasProjectId&&aliasProjectId===projectId){
			const currentAlias=Boolean(current.deploymentId&&aliasDeploymentId===String(current.deploymentId));
			return {domain,available:true,attached:currentAlias,reserved:true,current:currentAlias};
		}
		return {domain,available:false,attached:false,reserved:false,current:false,reason:'already_in_use'};
	}catch(error:any){
		const status=Number(error?.status||0);
		if(status===404)return {domain,available:true,attached:false,reserved:false,current:false};
		if(status===403||vercelAliasUnavailable(error))return {domain,available:false,attached:false,reserved:false,current:false,reason:'already_in_use'};
		throw error;
	}
}

export async function configureSharedEngineDomain(input:Record<string,any>={}){
	const current=await getSharedEngineHostState(true);
	const projectId=String(current.projectId||'').trim();
	const projectName=String(current.projectName||'').trim();
	if(!projectId||!projectName)throw fail('Deploy the Shared Engine before configuring its domain.',409,'ENGINE_HOST_NOT_DEPLOYED');
	const {token,teamId}=await credentialsFrom(input);
	if(!token)throw fail('Connect the owning Vercel account before configuring the Shared Engine domain.',409,'VERCEL_TOKEN_REQUIRED');
	const mode=String(input.mode||'generated').trim().toLowerCase();
	if(mode!=='generated'&&mode!=='vercel'&&mode!=='custom')throw fail('Unsupported Engine domain mode.',400,'ENGINE_DOMAIN_MODE_INVALID');
	const generatedDomain=`${projectName.toLowerCase()}.vercel.app`;
	if(mode==='generated'){
		const host=await saveSharedEngineHostState({
			domainMode:'generated',domainName:null,domainVerified:true,
			hostUrl:`https://${generatedDomain}`,lastSyncAt:new Date().toISOString(),lastError:null
		},current);
		await recordLicenseManagerCheckIn({
			action:'check_in',phase:'completed',product:'orbitfs_base',
			productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
			releaseId:current.releaseId,deploymentId:current.deploymentId,deploymentUrl:host.hostUrl,
			projectId,projectName,
			details:{deploymentProduct:'orbitfs_engine',engineHostUrl:host.hostUrl,mcpUrl:host.hostUrl?`${host.hostUrl}/mcp`:null,domainMode:'generated',domainName:null,domainVerified:true}
		});
		return {host,domain:{mode:'generated',generatedDomain,vercelDomain:null,customDomain:null,verified:true,effectiveUrl:host.hostUrl,mcpUrl:host.hostUrl?`${host.hostUrl}/mcp`:null}};
	}
	if(mode==='vercel'){
		const availability=await checkSharedEngineVercelDomainAvailability({...input,vercelToken:token,teamId});
		if(!availability.available)throw fail(`${availability.domain} is already in use on Vercel.`,409,'ENGINE_VERCEL_ALIAS_UNAVAILABLE');
		const domain=availability.domain;
		const deploymentId=String(current.deploymentId||current.pendingDeploymentId||'').trim();
		if(!deploymentId)throw fail('Engine deployment is not ready for a custom Vercel address.',409,'ENGINE_DEPLOYMENT_REQUIRED');
		if(!availability.attached){
			try{
				await vercelRequest(`/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`,token,teamId,{method:'POST',body:JSON.stringify({alias:domain,redirect:null})});
			}catch(error:any){
				if(Number(error?.status||0)===403||Number(error?.status||0)===409||vercelAliasUnavailable(error)){
					throw fail(`${domain} is already in use on Vercel.`,409,'ENGINE_VERCEL_ALIAS_UNAVAILABLE');
				}
				throw error;
			}
		}
		const host=await saveSharedEngineHostState({
			domainMode:'vercel',domainName:domain,domainVerified:true,
			hostUrl:`https://${domain}`,lastSyncAt:new Date().toISOString(),lastError:null
		},current);
		await recordLicenseManagerCheckIn({
			action:'check_in',phase:'completed',product:'orbitfs_base',
			productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
			releaseId:current.releaseId,deploymentId:current.deploymentId,deploymentUrl:host.hostUrl,
			projectId,projectName,
			details:{deploymentProduct:'orbitfs_engine',engineHostUrl:host.hostUrl,mcpUrl:host.hostUrl?`${host.hostUrl}/mcp`:null,domainMode:'vercel',domainName:domain,domainVerified:true}
		});
		return {host,domain:{mode:'vercel',generatedDomain,vercelDomain:domain,customDomain:null,verified:true,effectiveUrl:host.hostUrl,mcpUrl:host.hostUrl?`${host.hostUrl}/mcp`:null}};
	}
	const domain=normalizeDomainHost(input.domain,'Engine custom domain');
	if(domain.endsWith('.vercel.app'))throw fail('Choose Custom Vercel address for vercel.app names.',400,'ENGINE_CUSTOM_DOMAIN_REQUIRED');
	let domains=await sharedEngineProjectDomains(projectId,token,teamId);
	let entry=domains.find((item:any)=>String(item?.name||'').trim().toLowerCase()===domain);
	if(!entry){
		entry=await vercelRequest(`/v10/projects/${encodeURIComponent(projectId)}/domains`,token,teamId,{method:'POST',body:JSON.stringify({name:domain})});
	}
	// Ownership verification alone is not enough: routing DNS must also be correctly configured.
	const dnsConfig=await vercelRequest(`/v6/domains/${encodeURIComponent(domain)}/config`,token,teamId,{}, {projectIdOrName:projectId}).catch(()=>null);
	const verified=describeEngineDomainDns(domain,entry,dnsConfig).ready;
	const host=await saveSharedEngineHostState({
		domainMode:'custom',domainName:domain,domainVerified:verified,
		hostUrl:verified?`https://${domain}`:`https://${generatedDomain}`,
		lastSyncAt:new Date().toISOString(),lastError:verified?null:'Custom Engine domain is waiting for Vercel DNS verification.'
	},current);
	await recordLicenseManagerCheckIn({
		action:'check_in',phase:'completed',product:'orbitfs_base',
		productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
		releaseId:current.releaseId,deploymentId:current.deploymentId,deploymentUrl:host.hostUrl,
		projectId,projectName,
		details:{deploymentProduct:'orbitfs_engine',engineHostUrl:host.hostUrl,mcpUrl:host.hostUrl?`${host.hostUrl}/mcp`:null,domainMode:'custom',domainName:domain,domainVerified:verified}
	});
	return {host,domain:{mode:'custom',generatedDomain,vercelDomain:null,customDomain:domain,verified,effectiveUrl:host.hostUrl,mcpUrl:host.hostUrl?`${host.hostUrl}/mcp`:null}};
}

type PreparedDatabaseCredential={
	mode:'server-secret';
	dbSecret:string;
	serviceKey:string;
	derived:boolean;
};

type EngineDatabaseRuntimeAccessContract={
	version:1;
	schema:'public';
	publicReadTables:string[];
	runtimeSecretHeader:'x-orbitfs-secret';
	runtimeSecretRoles:string[];
	runtimeSecretTablePrefixes:string[];
	runtimeSecretExcludedTables:string[];
	runtimeSecretPreflightTables:string[];
	runtimeSecretRepairRpc:'orbitfs_repair_runtime_access';
	runtimeSecretProbeTable:'orbitfs_runtime_secret_probe';
};

type SupabaseConnectionAttestation={
	version:1;
	projectRef:string;
	publishableKeySha256:string;
	publishableKeyFormat:string;
	serverKeySha256:string;
	serverKeyFormat:string;
};

function supabaseApiKeyFormat(value:string){
	if(value.startsWith('sb_publishable_'))return 'publishable';
	if(value.startsWith('sb_secret_'))return 'secret';
	if(value.startsWith('eyJ')&&value.split('.').length===3)return 'legacy-jwt';
	return 'unknown';
}
function supabaseApiKeyFingerprint(value:string){return createHash('sha256').update(value).digest('hex')}
function supabaseProjectRefFromUrl(value:string){
	try{
		const host=new URL(value).hostname.toLowerCase();
		const suffix='.supabase.co';
		if(!host.endsWith(suffix))return '';
		return host.slice(0,-suffix.length);
	}catch{return ''}
}
function supabaseConnectionAttestation(){
	const encoded=String(env.ORBITFS_SUPABASE_CONNECTION_ATTESTATION||'').trim();
	const billingManaged=String(env.ORBITFS_INSTALLATION_ROUTE||'').trim().toLowerCase()==='billing_store';
	if(!encoded){
		if(billingManaged)throw fail('Billing-managed Base deployment is missing its validated Supabase connection attestation.',409,'ENGINE_SUPABASE_ATTESTATION_MISSING');
		return null;
	}
	let source:any;
	try{source=JSON.parse(encoded)}catch{throw fail('Supabase connection attestation is not valid JSON.',409,'ENGINE_SUPABASE_ATTESTATION_INVALID')}
	const attestation:SupabaseConnectionAttestation={
		version:Number(source?.version) as 1,
		projectRef:String(source?.projectRef||'').trim(),
		publishableKeySha256:String(source?.publishableKeySha256||'').trim().toLowerCase(),
		publishableKeyFormat:String(source?.publishableKeyFormat||'').trim(),
		serverKeySha256:String(source?.serverKeySha256||'').trim().toLowerCase(),
		serverKeyFormat:String(source?.serverKeyFormat||'').trim()
	};
	if(attestation.version!==1||!/^[a-z0-9]{20}$/.test(attestation.projectRef)||!/^[a-f0-9]{64}$/.test(attestation.publishableKeySha256)||!/^[a-f0-9]{64}$/.test(attestation.serverKeySha256)){
		throw fail('Supabase connection attestation is malformed.',409,'ENGINE_SUPABASE_ATTESTATION_INVALID');
	}
	const supabaseUrl=String(env.SUPABASE_URL||'').trim();
	const publishable=String(env.SUPABASE_PUBLISHABLE_KEY||'').trim();
	const server=String(env.SUPABASE_SECRET_KEY||'').trim();
	const urlRef=supabaseProjectRefFromUrl(supabaseUrl);
	if(urlRef!==attestation.projectRef){
		throw fail('Base Supabase URL does not match the Billing-selected Supabase project.',409,'ENGINE_SUPABASE_PROJECT_MISMATCH');
	}
	if(!publishable||supabaseApiKeyFingerprint(publishable)!==attestation.publishableKeySha256||supabaseApiKeyFormat(publishable)!==attestation.publishableKeyFormat){
		throw fail('Base Supabase publishable key does not match the credential validated by Billing.',409,'ENGINE_SUPABASE_PUBLISHABLE_KEY_MISMATCH');
	}
	if(!server||supabaseApiKeyFingerprint(server)!==attestation.serverKeySha256||supabaseApiKeyFormat(server)!==attestation.serverKeyFormat){
		throw fail('Base Supabase server key does not match the credential validated by Billing.',409,'ENGINE_SUPABASE_SERVER_KEY_MISMATCH');
	}
	return attestation;
}
function supabaseApiKeyHeaders(value:string){
	const headers:Record<string,string>={apikey:value,accept:'application/json','user-agent':'OrbitFS-Base-Deployer/1.0'};
	if(value.startsWith('eyJ')&&value.split('.').length===3)headers.authorization=`Bearer ${value}`;
	return headers;
}
async function assertSupabaseApiKeyAccepted(kind:'publishable'|'server',value:string){
	if(!value||supabaseApiKeyFormat(value)==='unknown'){
		throw fail(`Configured Supabase ${kind} API key has an unsupported format.`,409,kind==='publishable'?'ENGINE_DATABASE_PUBLISHABLE_KEY_INVALID':'ENGINE_DATABASE_SERVER_KEY_INVALID');
	}
	const supabaseUrl=String(env.SUPABASE_URL||'').trim().replace(/\/+$/,'');
	if(!supabaseUrl)throw fail('SUPABASE_URL is required before Supabase key validation.',409,'ENGINE_HOST_ENV_REQUIRED');
	let response:Response;
	try{
		response=await fetch(new URL('/auth/v1/settings',supabaseUrl),{
			headers:supabaseApiKeyHeaders(value),
			cache:'no-store',
			signal:AbortSignal.timeout(10_000)
		});
	}catch(error:any){
		throw fail(`Could not reach Supabase while validating the ${kind} API key: ${String(error?.message||error)}`,503,'ENGINE_DATABASE_KEY_PROBE_FAILED');
	}
	if(response.ok)return;
	const detail=(await response.text().catch(()=>'')).slice(0,500);
	if(response.status===401||response.status===403){
		throw fail(`Supabase rejected the configured ${kind} API key for the selected project.${detail?` ${detail}`:''}`,503,kind==='publishable'?'ENGINE_DATABASE_PUBLISHABLE_KEY_REJECTED':'ENGINE_DATABASE_SERVER_KEY_REJECTED');
	}
	throw fail(`Supabase ${kind} API-key validation returned HTTP ${response.status}.${detail?` ${detail}`:''}`,503,'ENGINE_DATABASE_KEY_PROBE_FAILED');
}

function runtimeAccessList(value:unknown,label:string,kind:'table'|'prefix'='table'){
	const values=Array.isArray(value)?[...new Set(value.map((item)=>String(item||'').trim()).filter(Boolean))]:[];
	const pattern=kind==='prefix'?/^[a-z_][a-z0-9_]*$/:/^[a-z_][a-z0-9_]*$/;
	if(!values.length||values.length>64||values.some((item)=>!pattern.test(item))){
		throw fail(`License Manager provided an invalid Engine database ${label} contract.`,502,'ENGINE_DATABASE_RUNTIME_ACCESS_CONTRACT_INVALID');
	}
	return values;
}

function engineDatabaseRuntimeAccessContract():EngineDatabaseRuntimeAccessContract{
	const encoded=String(env.ORBITFS_DATABASE_RUNTIME_ACCESS_CONTRACT||'').trim();
	if(!encoded)throw fail('License Manager runtime database access contract is missing from this Base deployment.',409,'ENGINE_DATABASE_RUNTIME_ACCESS_CONTRACT_MISSING');
	let source:any;
	try{source=JSON.parse(encoded);}catch{throw fail('License Manager runtime database access contract is not valid JSON.',502,'ENGINE_DATABASE_RUNTIME_ACCESS_CONTRACT_INVALID');}
	if(!source||typeof source!=='object'||Array.isArray(source)||Number(source.version)!==1||String(source.schema||'')!=='public'){
		throw fail('License Manager runtime database access contract is invalid.',502,'ENGINE_DATABASE_RUNTIME_ACCESS_CONTRACT_INVALID');
	}
	const publicReadTables=runtimeAccessList(source.publicReadTables,'public-read tables');
	const runtimeSecretRoles=runtimeAccessList(source.runtimeSecretRoles,'runtime roles');
	const runtimeSecretTablePrefixes=runtimeAccessList(source.runtimeSecretTablePrefixes,'table prefixes','prefix');
	const runtimeSecretExcludedTables=runtimeAccessList(source.runtimeSecretExcludedTables,'excluded tables');
	const runtimeSecretPreflightTables=runtimeAccessList(source.runtimeSecretPreflightTables,'preflight tables');
	const runtimeSecretHeader=String(source.runtimeSecretHeader||'');
	const runtimeSecretRepairRpc=String(source.runtimeSecretRepairRpc||'');
	const runtimeSecretProbeTable=String(source.runtimeSecretProbeTable||'').trim();
	if(runtimeSecretHeader!=='x-orbitfs-secret'||runtimeSecretRepairRpc!=='orbitfs_repair_runtime_access'||runtimeSecretProbeTable!=='orbitfs_runtime_secret_probe'||!['anon','authenticated'].every((role)=>runtimeSecretRoles.includes(role))){
		throw fail('License Manager runtime database access contract is unsupported by this Base deployer.',409,'ENGINE_DATABASE_RUNTIME_ACCESS_CONTRACT_UNSUPPORTED');
	}
	if(runtimeSecretPreflightTables.some((table)=>runtimeSecretExcludedTables.includes(table)||!runtimeSecretTablePrefixes.some((prefix)=>table.startsWith(prefix)))){
		throw fail('License Manager runtime database preflight tables are outside the authorized runtime table set.',502,'ENGINE_DATABASE_RUNTIME_ACCESS_CONTRACT_INVALID');
	}
	if(!runtimeSecretExcludedTables.includes(runtimeSecretProbeTable)||!runtimeSecretTablePrefixes.some((prefix)=>runtimeSecretProbeTable.startsWith(prefix))){
		throw fail('License Manager runtime database probe table must be inside the runtime namespace and excluded from generic DML repair.',502,'ENGINE_DATABASE_RUNTIME_ACCESS_CONTRACT_INVALID');
	}
	return {
		version:1,
		schema:'public',
		publicReadTables,
		runtimeSecretHeader:'x-orbitfs-secret',
		runtimeSecretRoles,
		runtimeSecretTablePrefixes,
		runtimeSecretExcludedTables,
		runtimeSecretPreflightTables,
		runtimeSecretRepairRpc:'orbitfs_repair_runtime_access',
		runtimeSecretProbeTable:'orbitfs_runtime_secret_probe'
	};
}

function missingDatabaseRuntimeRpc(error:any){
	const code=String(error?.code||'').toUpperCase();
	const message=String(error?.message||'').toLowerCase();
	return ['PGRST202','42883'].includes(code)||message.includes('orbitfs_set_runtime_secret')&&message.includes('not');
}

async function prepareEngineDatabaseCredential():Promise<PreparedDatabaseCredential>{
	supabaseConnectionAttestation();
	const database=engineDatabaseCredentials();
	if(database.mode==='missing'||!database.dbSecret){
		throw fail('No database runtime credential is available for the Shared Engine Host.',409,'ENGINE_HOST_DATABASE_CREDENTIAL_REQUIRED');
	}
	if(!database.serviceKey){
		throw fail('The Base deployment is missing its Supabase server repair credential. Reconfigure the customer deployment before provisioning the Shared Engine Host.',409,'ENGINE_DATABASE_REPAIR_CREDENTIAL_REQUIRED');
	}
	await assertSupabaseApiKeyAccepted('server',database.serviceKey);
	const digest=createHash('sha256').update(database.dbSecret).digest('hex');
	const synced=await getSupabaseAdmin().rpc('orbitfs_set_runtime_secret',{p_secret_sha256:digest,p_previous_grace_seconds:3600});
	if(synced.error){
		if(missingDatabaseRuntimeRpc(synced.error)){
			throw fail('The customer database is missing the current OrbitFS runtime-secret migration contract. Apply the current Base database migrations before provisioning the Shared Engine Host.',409,'ENGINE_DATABASE_RUNTIME_SECRET_CONTRACT_OUTDATED');
		}
		throw fail(`Could not synchronize the restricted Engine database credential: ${String(synced.error.message||synced.error)}`,503,'ENGINE_DATABASE_SECRET_SYNC_FAILED');
	}
	return {mode:'server-secret',dbSecret:database.dbSecret,serviceKey:database.serviceKey,derived:database.derived};
}

async function repairEngineDatabaseRuntimeAccess(database:PreparedDatabaseCredential,contract:EngineDatabaseRuntimeAccessContract){
	if(!database.serviceKey)throw fail('The Base deployment cannot repair Engine database access without its server repair credential.',409,'ENGINE_DATABASE_REPAIR_CREDENTIAL_REQUIRED');
	const repaired=await getSupabaseAdmin().rpc(contract.runtimeSecretRepairRpc,{
		p_table_prefixes:contract.runtimeSecretTablePrefixes,
		p_excluded_tables:contract.runtimeSecretExcludedTables,
		p_public_read_tables:contract.publicReadTables
	});
	if(repaired.error){
		const code=String(repaired.error.code||'').toUpperCase();
		const message=String(repaired.error.message||repaired.error);
		if(['PGRST202','42883'].includes(code)||message.toLowerCase().includes(contract.runtimeSecretRepairRpc)){
			throw fail('The customer database is missing the current OrbitFS runtime-access repair migration. Apply the current Base database migrations before provisioning the Shared Engine Host.',409,'ENGINE_DATABASE_RUNTIME_ACCESS_REPAIR_UNAVAILABLE');
		}
		throw fail(`Could not repair Shared Engine database runtime access: ${message}`,503,'ENGINE_DATABASE_RUNTIME_ACCESS_REPAIR_FAILED');
	}
	if(repaired.data&&typeof repaired.data==='object'&&(repaired.data as any).ok===false){
		throw fail('The customer database rejected the OrbitFS runtime-access repair.',503,'ENGINE_DATABASE_RUNTIME_ACCESS_REPAIR_FAILED');
	}
}

async function requiredEngineEnvironment(input:{version:string;releaseId:string;channel:string;projectName:string;baseVersion:string|null;installationId:string},database:PreparedDatabaseCredential,contract:EngineDatabaseRuntimeAccessContract) {
	const licenseProvider=await getLicenseProviderSettings();
	const values:Record<string,string> = {
		SUPABASE_URL: String(env.SUPABASE_URL || '').trim(),
		SUPABASE_PUBLISHABLE_KEY: String(env.SUPABASE_PUBLISHABLE_KEY || '').trim(),
		ORBITFS_DB_SECRET:database.dbSecret,
		ORBITFS_DATABASE_RUNTIME_ACCESS_CONTRACT:JSON.stringify(contract),
		ORBITFS_ENGINE_SECRET: engineSharedSecret(),
		ORBITFS_INSTALLATION_ID: String(input.installationId || '').trim(),
		ORBITFS_PANEL_URL: configuredPanelUrl(),
		ORBITFS_ENGINE_HOST_URL: `https://${input.projectName}.vercel.app`,
		ORBITFS_LICENSE_API_URL: String(licenseProvider.providerBase || '').trim(),
		ORBITFS_ENGINE_RELEASE_PROVIDER: await resolveUpdaterProviderBase(),
		ORBITFS_APP_VERSION: String(input.version || '').trim(),
		ORBITFS_BASE_VERSION: String(input.baseVersion || (process.env.VERCEL_GIT_COMMIT_SHA ? `development-${process.env.VERCEL_GIT_COMMIT_SHA.slice(0,12)}` : 'development')).trim(),
		ORBITFS_ENGINE_RELEASE_ID: String(input.releaseId || '').trim(),
		ORBITFS_RELEASE_CHANNEL: String(input.channel || 'stable').trim().toLowerCase(),
		ORBITFS_UPDATE_CHANNEL: String(input.channel || 'stable').trim().toLowerCase()
	};
	for (const [key, value] of Object.entries(values)) {
		if (!value) throw fail(`${key} is required before the Shared Engine Host can be provisioned.`, 409, 'ENGINE_HOST_ENV_REQUIRED');
	}
	return Object.entries(values).map(([key, value]) => ({ key, value, type: 'encrypted', target: ['production'] }));
}

function engineRuntimeRequestHeaders(database:PreparedDatabaseCredential,contract:EngineDatabaseRuntimeAccessContract){
	const publishableKey=String(env.SUPABASE_PUBLISHABLE_KEY||'').trim();
	if(!publishableKey||!['publishable','legacy-jwt'].includes(supabaseApiKeyFormat(publishableKey))){
		throw fail('SUPABASE_PUBLISHABLE_KEY is not a recognized Supabase publishable/anon key.',409,'ENGINE_DATABASE_PUBLISHABLE_KEY_INVALID');
	}
	return {
		...supabaseApiKeyHeaders(publishableKey),
		[contract.runtimeSecretHeader]:database.dbSecret
	};
}

function engineDatabaseResponseFailure(response:Response,body:any,subject:string){
	const detail=body&&typeof body==='object'?String(body.message||body.error_description||body.error||'').trim():'';
	const code=body&&typeof body==='object'?String(body.code||'').trim().toUpperCase():'';
	const normalized=`${code} ${detail}`.toLowerCase();
	if(code==='42501'||normalized.includes('permission denied')){
		return fail(`Shared Engine database runtime access is not installed correctly for ${subject}.${detail?` ${detail}`:''}`,503,'ENGINE_DATABASE_RUNTIME_ACCESS_DENIED');
	}
	if(response.status===401){
		return fail(`Supabase rejected the configured publishable key while checking ${subject}.${detail?` ${detail}`:''}`,503,'ENGINE_DATABASE_PUBLISHABLE_KEY_REJECTED');
	}
	return fail(`Shared Engine database preflight failed for ${subject} with Supabase ${response.status}.${detail?` ${detail}`:''}`,503,'ENGINE_DATABASE_PREFLIGHT_FAILED');
}

async function assertEngineDatabaseAccess(database:PreparedDatabaseCredential,contract:EngineDatabaseRuntimeAccessContract) {
	supabaseConnectionAttestation();
	const supabaseUrl=String(env.SUPABASE_URL||'').trim().replace(/\/+$/,'');
	if(!supabaseUrl)throw fail('SUPABASE_URL is required before Shared Engine database preflight.',409,'ENGINE_HOST_ENV_REQUIRED');
	const publishableKey=String(env.SUPABASE_PUBLISHABLE_KEY||'').trim();
	await assertSupabaseApiKeyAccepted('publishable',publishableKey);
	const headers=engineRuntimeRequestHeaders(database,contract);

	let probeResponse:Response;
	const probeUrl=new URL(`/rest/v1/${encodeURIComponent(contract.runtimeSecretProbeTable)}`,supabaseUrl);
	probeUrl.searchParams.set('select','probe_key,contract_version');
	probeUrl.searchParams.set('probe_key','eq.runtime');
	probeUrl.searchParams.set('limit','1');
	try{
		probeResponse=await fetch(probeUrl,{
			headers,
			cache:'no-store',
			signal:AbortSignal.timeout(10_000)
		});
	}catch(error:any){
		throw fail(`Shared Engine runtime-secret preflight could not reach Supabase: ${String(error?.message||error)}`,503,'ENGINE_DATABASE_PREFLIGHT_FAILED');
	}
	const probeBody:any=await probeResponse.json().catch(()=>null);
	if(!probeResponse.ok)throw engineDatabaseResponseFailure(probeResponse,probeBody,'the runtime-secret probe table');
	if(!Array.isArray(probeBody)||probeBody.length!==1||probeBody[0]?.probe_key!=='runtime'||Number(probeBody[0]?.contract_version)!==1){
		throw fail('Supabase did not accept the restricted OrbitFS database runtime secret.',409,'ENGINE_DATABASE_RUNTIME_SECRET_REJECTED');
	}
	for(const table of contract.runtimeSecretPreflightTables){
		const url=new URL(`/rest/v1/${table}`,supabaseUrl);
		url.searchParams.set('select','id');
		url.searchParams.set('limit','1');
		let response:Response;
		try{
			response=await fetch(url,{headers,cache:'no-store',signal:AbortSignal.timeout(10_000)});
		}catch(error:any){
			throw fail(`Shared Engine database preflight could not reach Supabase while checking ${table}: ${String(error?.message||error)}`,503,'ENGINE_DATABASE_PREFLIGHT_FAILED');
		}
		const body:any=await response.json().catch(()=>null);
		if(!response.ok)throw engineDatabaseResponseFailure(response,body,table);
		if(!Array.isArray(body)){
			throw fail(`Shared Engine database preflight returned an invalid response for ${table}.`,503,'ENGINE_DATABASE_PREFLIGHT_FAILED');
		}
	}
}

type PreparedEngineMigration={
	id:string;
	file:string;
	component:string;
	sha256:string;
	sql:string;
	statements:string[];
};

type EngineMigrationState={
	migrations:PreparedEngineMigration[];
	missing:PreparedEngineMigration[];
	trackingAvailable:boolean;
};

function splitSqlStatements(sql:string){
	const statements:string[]=[];
	let start=0;
	let single=false,double=false,lineComment=false,blockDepth=0,dollar:string|null=null;
	for(let i=0;i<sql.length;i+=1){
		const ch=sql[i],next=sql[i+1]||'';
		if(lineComment){if(ch==='\n')lineComment=false;continue;}
		if(blockDepth>0){if(ch==='/'&&next==='*'){blockDepth+=1;i+=1;continue;}if(ch==='*'&&next==='/'){blockDepth-=1;i+=1;}continue;}
		if(dollar){if(sql.startsWith(dollar,i)){i+=dollar.length-1;dollar=null;}continue;}
		if(single){if(ch==="'"&&next==="'"){i+=1;continue;}if(ch==="'")single=false;continue;}
		if(double){if(ch==='"'&&next==='"'){i+=1;continue;}if(ch==='"')double=false;continue;}
		if(ch==='-'&&next==='-'){lineComment=true;i+=1;continue;}
		if(ch==='/'&&next==='*'){blockDepth=1;i+=1;continue;}
		if(ch==="'"){single=true;continue;}
		if(ch==='"'){double=true;continue;}
		if(ch==='$'){
			const match=sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
			if(match){dollar=match[0];i+=dollar.length-1;continue;}
		}
		if(ch===';'){
			const statement=sql.slice(start,i+1).trim();
			if(statement)statements.push(statement);
			start=i+1;
		}
	}
	if(single||double||dollar||blockDepth>0)throw fail('Engine database migration contains unterminated SQL syntax.',502,'ENGINE_DATABASE_MIGRATION_SQL_INVALID');
	const tail=sql.slice(start).trim();
	if(tail)statements.push(tail);
	return statements;
}

function preparedEngineMigrations(packageData:any,descriptor:any):PreparedEngineMigration[]{
	const database=packageData?.database;
	const migrations=Array.isArray(database?.migrations)?database.migrations:[];
	if(!migrations.length)return[];
	if(database?.format!=='orbitfs-db-migrations-v1'||database?.mode!=='shared-panel'||database?.provider!=='supabase'||Number(database?.migrationCount)!==migrations.length){
		throw fail('Engine release contains an invalid database migration contract.',502,'ENGINE_DATABASE_MIGRATION_CONTRACT_INVALID');
	}
	const selected=new Set((descriptor?.components||[]).map((value:any)=>String(value||'').trim().toLowerCase()));
	const ids=new Set<string>();
	return migrations.map((migration:any)=>{
		const id=String(migration?.id||'').trim();
		const file=String(migration?.file||'').trim().replaceAll('\\','/');
		const component=String(migration?.component||'').trim().toLowerCase();
		const sha256=String(migration?.sha256||'').trim().toLowerCase();
		if(!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(id)||ids.has(id))throw fail('Engine release contains an invalid or duplicate database migration id.',502,'ENGINE_DATABASE_MIGRATION_CONTRACT_INVALID');
		ids.add(id);
		const match=file.match(/^supabase\/migrations\/(shared|apex|mcp|studio)\/\d{14}_[A-Za-z0-9._-]+\.sql$/);
		if(!match||component!==match[1]||(component!=='shared'&&!selected.has(component)))throw fail('Engine release migration target is invalid: '+file,502,'ENGINE_DATABASE_MIGRATION_CONTRACT_INVALID');
		if(!/^[a-f0-9]{64}$/.test(sha256)||migration?.encoding!=='base64'||typeof migration?.data!=='string')throw fail('Engine release migration integrity metadata is invalid: '+file,502,'ENGINE_DATABASE_MIGRATION_CONTRACT_INVALID');
		const bytes=Buffer.from(migration.data,'base64');
		if(bytes.length<1||bytes.length>2*1024*1024||Number(migration.size)!==bytes.length||createHash('sha256').update(bytes).digest('hex')!==sha256)throw fail('Engine release migration checksum failed: '+file,502,'ENGINE_DATABASE_MIGRATION_CHECKSUM_FAILED');
		const sql=bytes.toString('utf8');
		if(/\b(?:begin|commit|rollback)\s*;/i.test(sql))throw fail('Engine release migration contains explicit transaction control: '+file,502,'ENGINE_DATABASE_MIGRATION_SQL_INVALID');
		if(/\b(?:drop\s+table|drop\s+schema|truncate\s+(?:table\s+)?|alter\s+table[\s\S]{0,300}?drop\s+column)\b/i.test(sql))throw fail('Engine release migration contains a destructive operation: '+file,502,'ENGINE_DATABASE_MIGRATION_DESTRUCTIVE');
		const statements=splitSqlStatements(sql);
		if(!statements.length||statements.length>1000)throw fail('Engine release migration statement list is invalid: '+file,502,'ENGINE_DATABASE_MIGRATION_SQL_INVALID');
		return{id,file,component,sha256,sql,statements};
	});
}

// Read-only comparison between installed ledger and latest authorized Update.
export async function inspectInstalledEngineDatabase() {
  const current=await getSharedEngineHostState();
  if(current.pendingDeploymentId) throw fail('Engine deployment is in progress.',409,'ENGINE_DATABASE_DEPLOYMENT_PENDING');
  const authorizedLatest=await fetchEngineBootstrapRelease(current.releaseChannel || null);
  if(!current.releaseId) assertInitialEngineRelease(authorizedLatest);
  const latest=(await scopeEngineReleaseForInstalledLicenses(authorizedLatest,undefined)).release;
  const databaseContract=await resolveEngineDatabaseContract(latest,latest.descriptor);
  const state=await inspectEngineDatabaseMigrations(databaseContract.packageData,latest.descriptor);
  if(!state.trackingAvailable) throw fail('Apply the current approved Base schema before Engine migrations.',409,'ENGINE_DATABASE_MIGRATION_EXECUTOR_REQUIRED');
  const releaseMatches=current.releaseId===latest.descriptor.releaseId;
  return {
    status:!releaseMatches?(current.releaseId?'update_required':'install_required'):state.missing.length?'migrations_required':'current',
    releaseId:latest.descriptor.releaseId,version:latest.descriptor.version,sourceCommit:latest.descriptor.sourceCommit,
    installedReleaseId:current.releaseId,releaseMatches,migrationCount:state.migrations.length,
    missing:state.missing.map(({id,file,component,sha256})=>({id,file,component,sha256})),
    repairSupported:releaseMatches && ['orbitfs-store-package-v1','orbitfs-authorized-branch-v1'].includes(String(current.distribution))
  };
}

async function resolveEngineDatabaseContract(release:any,descriptor:any){
	const components:string[]=[...new Set<string>((descriptor?.components||[]).map((item:any)=>String(item||'').trim().toLowerCase()).filter((item:string)=>ENGINE_COMPONENT_IDS.includes(item as any)))];
	if(!components.length)throw fail('At least one Engine component is required before resolving its database package.',400,'ENGINE_DATABASE_COMPONENT_REQUIRED');

	// The authorized Engine payload is source-locked and checksum-verified by
	// License Manager. Engine packaging builds this cumulative contract directly
	// from supabase/migrations/{shared,mcp,apex,studio}; use that exact contract
	// for first install/update instead of requiring a second published DB row.
	const packagedDatabase=release?.package?.database;
	if(packagedDatabase&&typeof packagedDatabase==='object'&&!Array.isArray(packagedDatabase)){
		const migrations=Array.isArray(packagedDatabase.migrations)?packagedDatabase.migrations:[];
		if(
			packagedDatabase.format!=='orbitfs-db-migrations-v1'||
			packagedDatabase.mode!=='shared-panel'||
			packagedDatabase.provider!=='supabase'||
			Number(packagedDatabase.migrationCount)!==migrations.length
		){
			throw fail('Authorized Engine package contains an invalid database migration contract.',502,'ENGINE_DATABASE_MIGRATION_CONTRACT_INVALID');
		}
		preparedEngineMigrations({database:packagedDatabase},descriptor);
		return{
			packageData:{database:packagedDatabase},
			source:'authorized-engine-package',
			packages:[]
		};
	}

	// Backward compatibility for an older Engine payload without an embedded
	// cumulative migration contract.
	let registry:any;
	try{
		registry=await fetchEngineDatabasePackageSet(components);
	}catch(error:any){
		const code=String(error?.code||'').trim().toUpperCase();
		if(code==='DATABASE_PACKAGE_NOT_FOUND'||code==='DATABASE_PACKAGE_FETCH_FAILED'||Number(error?.status||0)===404){
			throw fail(
				'Authorized Engine package has no database contract and no compatible central database package is published.',
				409,
				'ENGINE_DATABASE_PACKAGE_REQUIRED'
			);
		}
		throw error;
	}
	return{
		packageData:{database:registry.database},
		source:'license-manager-registry',
		packages:registry.packages.map((item:any)=>({
			id:item.id,
			component:item.component,
			databaseSchemaVersion:item.databaseSchemaVersion,
			minimumBaseSchemaVersion:item.minimumBaseSchemaVersion,
			sha256:item.sha256,
			sourceCommit:item.sourceCommit
		}))
	};
}

function migrationTrackingMissing(error:any){
	const code=String(error?.code||'').toUpperCase();
	const message=String(error?.message||'').toLowerCase();
	return ['42P01','PGRST204','PGRST205'].includes(code)||(message.includes('orbitfs_schema_migrations')&&(message.includes('not')||message.includes('schema cache')));
}

async function inspectEngineDatabaseMigrations(packageData:any,descriptor:any):Promise<EngineMigrationState>{
	const migrations=preparedEngineMigrations(packageData,descriptor);
	if(!migrations.length)return{migrations,missing:[],trackingAvailable:true};
	const result=await getSupabaseAdmin().from('orbitfs_schema_migrations').select('migration_id,source_file,component,sha256').in('migration_id',migrations.map((migration)=>migration.id));
	if(result.error){
		if(migrationTrackingMissing(result.error))return{migrations,missing:migrations,trackingAvailable:false};
		throw fail('Could not read Engine database migration state: '+result.error.message,503,'ENGINE_DATABASE_MIGRATION_STATE_FAILED');
	}
	const applied=new Map((result.data||[]).map((row:any)=>[String(row.migration_id),row]));
	const missing:PreparedEngineMigration[]=[];
	for(const migration of migrations){
		const row:any=applied.get(migration.id);
		if(!row){missing.push(migration);continue;}
		if(String(row.sha256||'').toLowerCase()!==migration.sha256||String(row.source_file||'')!==migration.file||String(row.component||'')!==migration.component){
			throw fail('Published Engine migration identity/checksum conflict: '+migration.id,409,'ENGINE_DATABASE_MIGRATION_CONFLICT');
		}
	}
	return{migrations,missing,trackingAvailable:true};
}

async function applyEngineDatabaseMigrations(state:EngineMigrationState,descriptor:any){
	if(!state.missing.length)return[];
	if(!state.trackingAvailable){
		throw fail('This Base installation is missing the Engine update migration runtime. Apply the current Base release schema before deploying Engine updates.',409,'ENGINE_DATABASE_MIGRATION_EXECUTOR_REQUIRED');
	}
	const db=getSupabaseAdmin();
	const applied:any[]=[];
	for(const migration of state.missing){
		const result=await db.rpc('orbitfs_apply_update_migration',{
			p_migration_id:migration.id,
			p_source_file:migration.file,
			p_component:migration.component,
			p_sha256:migration.sha256,
			p_source_sql:migration.sql,
			p_statements:migration.statements,
			p_release_id:String(descriptor?.releaseId||''),
			p_release_version:String(descriptor?.version||'')
		});
		if(result.error){
			const code=String(result.error.code||'').toUpperCase();
			const message=String(result.error.message||result.error);
			if(['PGRST202','42883'].includes(code)||message.includes('orbitfs_apply_update_migration')){
				throw fail('This Base installation is missing the Engine update migration executor. Apply the current Base release schema before deploying Engine updates.',409,'ENGINE_DATABASE_MIGRATION_EXECUTOR_REQUIRED');
			}
			if(applied.length) throw fail('Engine migration '+migration.id+' failed after '+applied.length+' earlier migration(s) were applied. Those forward-only migrations have NOT been rolled back. Inspect database-status and retry this same approved release: '+message,409,'ENGINE_DATABASE_PARTIAL_MIGRATION');
			throw fail('Engine database migration '+migration.id+' failed: '+message,409,'ENGINE_DATABASE_MIGRATION_FAILED');
		}
		applied.push({id:migration.id,file:migration.file,component:migration.component,sha256:migration.sha256,result:result.data||null});
	}
	const verified=await inspectEngineDatabaseMigrations({
		database:{
			format:'orbitfs-db-migrations-v1',
			mode:'shared-panel',
			provider:'supabase',
			migrationCount:state.migrations.length,
			migrations:state.migrations.map((migration)=>({
				id:migration.id,
				file:migration.file,
				component:migration.component,
				sha256:migration.sha256,
				encoding:'base64',
				data:Buffer.from(migration.sql,'utf8').toString('base64'),
				size:Buffer.byteLength(migration.sql,'utf8')
			}))
		}
	},descriptor);
	if(verified.missing.length)throw fail('Engine database migrations were applied but verification is incomplete.',503,'ENGINE_DATABASE_MIGRATION_VERIFY_FAILED');
	return applied;
}

function publicVercelUrl(value: unknown) {
	const raw = String(value || '').trim();
	if (!raw) return null;
	return raw.startsWith('http://') || raw.startsWith('https://') ? raw.replace(/\/$/, '') : `https://${raw.replace(/\/$/, '')}`;
}

function deploymentReadyState(deployment: any) {
	return String(deployment?.readyState || deployment?.state || deployment?.status || 'UNKNOWN').trim().toUpperCase();
}

function deploymentFailed(state: string) {
	return ['ERROR', 'CANCELED', 'CANCELLED'].includes(state);
}

async function uploadReleaseFiles(files: Array<{ file: string; data: string; encoding: 'base64' | 'utf-8' }>, token: string, teamId: string) {
	const uploaded=new Array<{file:string;sha:string;size:number}>(files.length);
	const uploadOne=async(file:{file:string;data:string;encoding:'base64'|'utf-8'},index:number)=>{
		const bytes=file.encoding==='base64'?Buffer.from(file.data,'base64'):Buffer.from(file.data,'utf8');
		const sha=createHash('sha1').update(bytes).digest('hex');
		let response=await fetch(requestUrl('/v2/files',teamId),{
			method:'POST',
			headers:{
				authorization:`Bearer ${token}`,
				'content-type':'application/octet-stream',
				'content-length':String(bytes.length),
				'x-vercel-digest':sha
			},
			body:new Uint8Array(bytes),
			signal:AbortSignal.timeout(Math.max(8_000,Number(env.ORBITFS_VERCEL_TIMEOUT_MS||30_000)))
		});
		if(!response.ok&&response.status===404){
			response=await fetch(requestUrl('/v2/now/files',teamId),{
				method:'POST',
				headers:{
					authorization:`Bearer ${token}`,
					'content-type':'application/octet-stream',
					'content-length':String(bytes.length),
					'x-now-digest':sha
				},
				body:new Uint8Array(bytes),
				signal:AbortSignal.timeout(Math.max(8_000,Number(env.ORBITFS_VERCEL_TIMEOUT_MS||30_000)))
			});
		}
		if(!response.ok&&response.status!==409){
			throw fail(`Vercel file upload failed for ${file.file}: ${await response.text()}`,response.status<500?response.status:503,'VERCEL_FILE_UPLOAD_FAILED');
		}
		uploaded[index]={file:file.file,sha,size:bytes.length};
	};
	const concurrency=Math.max(1,Math.min(8,Number(env.ORBITFS_VERCEL_UPLOAD_CONCURRENCY||6)));
	let cursor=0;
	const workers=Array.from({length:Math.min(concurrency,files.length)},async()=>{
		while(true){
			const index=cursor++;
			if(index>=files.length)return;
			await uploadOne(files[index],index);
		}
	});
	await Promise.all(workers);
	return uploaded;
}

export async function engineHostProvisioningStatus() {
	const credentials = await credentialsFrom();
	const database=engineDatabaseCredentials();
	const baseVersion=await resolveInstalledBaseVersion();
	let licenseProviderAvailable=false;
	let bootstrapEntitlement:{eligible:boolean;componentId:string|null;licenseComponent:string|null;reason:string|null;licensedIds:string[]}={eligible:false,componentId:null,licenseComponent:null,reason:'LICENSE_REQUIRED',licensedIds:[]};
	try{
		licenseProviderAvailable=Boolean((await getLicenseProviderSettings()).providerBase);
		if(licenseProviderAvailable)bootstrapEntitlement=await engineHostBootstrapEntitlement();
	}catch{}
	const missing:string[]=[];
	if(!credentials.token) missing.push('Vercel connection');
	if(!String(env.SUPABASE_URL||'').trim()) missing.push('SUPABASE_URL');
	if(!String(env.SUPABASE_PUBLISHABLE_KEY||'').trim()) missing.push('SUPABASE_PUBLISHABLE_KEY');
	if(database.mode==='missing') missing.push('database runtime credential');
	if(database.mode!=='missing'&&!database.serviceKey) missing.push('Supabase server repair credential');
	try{engineDatabaseRuntimeAccessContract();}catch{missing.push('License Manager database runtime access contract');}
	if(!engineSharedSecret()) missing.push('Engine shared secret');
	if(!licenseProviderAvailable) missing.push('official licence provider');
	if(licenseProviderAvailable&&!bootstrapEntitlement.eligible) missing.push('active OrbitFS add-on licence');
	return {available:missing.length===0,missing,vercelConnected:Boolean(credentials.token),databaseCredentialMode:database.mode==='server-secret'?(database.derived?'derived-server-secret':'server-secret'):database.mode,baseVersion,baseVersionKnown:Boolean(baseVersion),bootstrapEntitlement};
}

export async function engineHostProvisioningAvailable() {
	return (await engineHostProvisioningStatus()).available;
}


async function finalizeReadyEngineRelease(host:any,input:{
	version:string;
	releaseId:string;
	channel:string;
	sha256:string;
	sourceCommit?:string|null;
	components:string[];
	componentVersions:Record<string,string|null>;
	fileInventory:Array<{file:string;component:string;sha256:string;size:number}>;
	deploymentId?:string|null;
	deploymentUrl?:string|null;
	verifyUpdater?:boolean;
	distribution?:'orbitfs-store-package-v1'|'orbitfs-git-dev-v1'|'orbitfs-authorized-branch-v1';
}) {
	const components=[...new Set((input.components||[]).map((value)=>String(value||'').trim().toLowerCase()).filter(Boolean))];
	const preparedAddons=await prepareInstalledEngineAddonLicenses();
	const authorizedNow:string[]=[];
	for(const component of components){
		const manifest=CLOUD_ADDON_MANIFESTS[component];
		const licenseComponent=String(manifest?.licenseComponent||'').trim();
		if(!licenseComponent)throw fail('Engine component authorization mapping is missing: '+component,409,'ENGINE_COMPONENT_AUTHORIZATION_CHANGED');
		try{
			await assertAddonLicensed(licenseComponent,false);
			authorizedNow.push(component);
		}catch{
			throw fail('Engine component authorization changed while the deployment was running: '+component,409,'ENGINE_COMPONENT_AUTHORIZATION_CHANGED');
		}
	}
	const activeRelease=await getActiveRelease();
	const previousEngine=activeRelease?.engine&&typeof activeRelease.engine==='object'?activeRelease.engine:{};
	const mergedComponents=[...new Set([...(Array.isArray(previousEngine.components)?previousEngine.components:[]),...components].map((value)=>String(value||'').trim().toLowerCase()).filter((value)=>authorizedNow.includes(value)))];
	const mergedVersionsRaw:Record<string,unknown>={...(previousEngine.componentVersions&&typeof previousEngine.componentVersions==='object'?previousEngine.componentVersions:{}),...(input.componentVersions||{})};
	const mergedComponentVersions:Record<string,string|null>=Object.fromEntries(
		Object.entries(mergedVersionsRaw)
			.filter(([component])=>mergedComponents.includes(String(component).toLowerCase()))
			.map(([component,version])=>[String(component).toLowerCase(),version===null?null:String(version||'')||null])
	);
	const db=getSupabaseAdmin();

	for(const id of components){
		if(!['mcp','apex','studio'].includes(id)) continue;
		const currentAddon=await db.from('orbitfs_addons').select('runtime,installed,attached,configured,status,deployment_url').eq('id',id).maybeSingle();
		if(currentAddon.error) throw currentAddon.error;
		if(!currentAddon.data || (currentAddon.data.installed!==true && currentAddon.data.attached!==true)) continue;
		const runtime=currentAddon.data.runtime&&typeof currentAddon.data.runtime==='object'?currentAddon.data.runtime:{};
		const componentVersion=input.componentVersions?.[id]||input.version;
		const nextRuntime={
			...runtime,
			mode:'engine-host',
			engineMode:id==='mcp'?(runtime.engineMode==='stopped'?'stopped':'running'):(runtime.engineMode||'standby'),
			setupState:runtime.setupState||'not_started',
			engineReleaseId:input.releaseId,
			engineVersion:componentVersion,
			engineDeploymentId:String(input.deploymentId||''),
			engineHostUrl:host.hostUrl,
			installMethod:String(host.installationRoute||'standard'),
			compute:'vercel',
			database:'supabase',
			online:true
		};
		const update=await db.from('orbitfs_addons').update({
			deployment_url:host.hostUrl||currentAddon.data.deployment_url||null,
			runtime:nextRuntime,
			status:currentAddon.data.status,
			updated_at:new Date().toISOString()
		}).eq('id',id);
		if(update.error) throw update.error;
	}

	let updater:any=null;
	if(input.verifyUpdater!==false){
		try{
			updater=input.distribution==='orbitfs-authorized-branch-v1'
				? await verifyAuthorizedEngineBranch({releaseId:input.releaseId,sourceCommit:String(input.sourceCommit||''),sha256:input.sha256})
				: await verifyEngineUpdaterRelease({releaseId:input.releaseId,channel:input.channel});
		}catch(error:any){
			const detail=String(error?.message||'Updater verification failed');
			await saveSharedEngineHostState({
				updaterConnected:false,
				updaterLastVerifiedAt:new Date().toISOString(),
				updaterLastError:detail,
				lastError:`Engine deployment reached READY but updater authority verification failed: ${detail}`
			},host).catch(()=>undefined);
			throw fail(`Engine deployment reached READY but updater registration could not be verified: ${detail}`,Number(error?.status||503),'ENGINE_UPDATER_REGISTRATION_FAILED');
		}
	}

	await setEngineActiveRelease({
		version:input.version,
		releaseId:input.releaseId,
		sha256:input.sha256,
		sourceCommit:input.sourceCommit||null,
		components:mergedComponents,
		componentVersions:mergedComponentVersions,
		fileInventory:input.fileInventory||[],
		deploymentId:input.deploymentId||null
	});

	const finalized=await saveSharedEngineHostState({
		deploymentId:input.deploymentId||host.deploymentId||null,
		deploymentUrl:input.deploymentUrl||host.deploymentUrl||null,
		releaseVersion:input.version,
		releaseId:input.releaseId,
		releaseChannel:input.channel,
		releaseSha256:input.sha256,
		releaseSourceCommit:input.sourceCommit||null,
		releaseFileCount:input.fileInventory?.length||0,
		pendingDeploymentId:null,
		pendingDeploymentUrl:null,
		pendingReleaseVersion:null,
		pendingReleaseId:null,
		pendingReleaseChannel:null,
		pendingReleaseSha256:null,
		pendingReleaseSourceCommit:null,
		pendingReleaseFileCount:null,
		pendingReleaseInventory:null,
		pendingReleaseComponents:[],
		pendingReleaseComponentVersions:{},
		distribution:input.distribution||host.distribution||'orbitfs-store-package-v1',
		updaterConnected:Boolean(updater),
		updaterConnectedAt:updater?(host.updaterConnectedAt||new Date().toISOString()):null,
		updaterProvider:updater?.provider||null,
		updaterProtocol:updater?.protocol||null,
		updaterLastVerifiedAt:updater?.verifiedAt||null,
		updaterLastError:null
	},host);

	// The deployed Host is the Engine baseline. Published updates can attach
	// updater authority later; the initial Git bootstrap does not require one.

	await recordLicenseManagerCheckIn({
		action:'check_in',
		phase:'completed',
		product:'orbitfs_base',
		productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
		releaseId:input.releaseId,
		deploymentId:input.deploymentId||null,
		deploymentUrl:finalized.deploymentUrl||null,
		projectId:finalized.projectId||null,
		projectName:finalized.projectName||null,
		details:{
			deploymentProduct:'orbitfs_engine',
			engineVersion:input.version,
			engineReady:true,
			updaterConnected:Boolean(updater),
			updaterProvider:updater?.provider||null,
			updaterChannel:input.channel,
			engineDeployerProtocol:ENGINE_DEPLOYER_PROTOCOL,
			targetComponents:components,
			components:Object.fromEntries(components.map((id)=>[id,input.componentVersions?.[id]||input.version]))
		}
	});

	return finalized;
}


export async function registerSharedEngineUpdater(input: Record<string, any> = {}) {
	const current=await getSharedEngineHostState();
	if(!current.hostUrl || !['deployed','linked','ready'].includes(String(current.state||''))) {
		throw fail('Deploy the Shared Engine before registering it with the updater.',409,'ENGINE_HOST_NOT_DEPLOYED');
	}
	const channel=String(input.releaseChannel||input.channel||current.releaseChannel||env.ORBITFS_UPDATE_CHANNEL||'stable').trim().toLowerCase()||'stable';
	if(current.distribution==='orbitfs-store-package-v1'){
		const currentReleaseId=String(current.releaseId||'').trim();
		if(!currentReleaseId)throw fail('The published Engine release identity is missing.',409,'ENGINE_RELEASE_ID_REQUIRED');
		try{
			const verified=await verifyEngineUpdaterRelease({releaseId:currentReleaseId,channel});
			const host=await saveSharedEngineHostState({
				releaseChannel:verified.channel,
				updaterConnected:true,
				updaterConnectedAt:current.updaterConnectedAt||new Date().toISOString(),
				updaterProvider:verified.provider,
				updaterProtocol:verified.protocol,
				updaterLastVerifiedAt:verified.verifiedAt,
				updaterLastError:null
			},current);
			await recordLicenseManagerCheckIn({
				action:'check_in',phase:'completed',product:'orbitfs_base',
				productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
				releaseId:currentReleaseId,deploymentId:current.deploymentId,
				deploymentUrl:current.deploymentUrl,projectId:current.projectId,projectName:current.projectName,
				details:{deploymentProduct:'orbitfs_engine',engineVersion:current.releaseVersion,engineReady:true,updaterConnected:true,updaterProvider:verified.provider,updaterChannel:verified.channel,engineDeployerProtocol:verified.protocol,registrationSync:true,releaseSource:'published-update'}
			});
			return {host,synced:true,conflict:false,updateStarted:false,latest:{releaseId:currentReleaseId,version:current.releaseVersion,channel:verified.channel,source:'published-update'}};
		}catch(error:any){
			if(!authorityUnavailable(error))throw error;
			const host=await saveSharedEngineHostState({
				updaterConnected:false,updaterLastVerifiedAt:new Date().toISOString(),
				updaterLastError:'Published Engine release authority temporarily unavailable.',lastError:null
			},current);
			return {host,synced:false,conflict:false,updateStarted:false,authorityUnavailable:true,fallback:'keep-current-release',latest:null,errorCode:String(error?.code||'ENGINE_RELEASE_UNAVAILABLE')};
		}
	}
	let latest: Awaited<ReturnType<typeof fetchAuthorizedEngineBranch>>;
	try {
		latest=await fetchAuthorizedEngineBranch();
	} catch(error:any) {
		if(!authorityUnavailable(error)) throw error;
		const host=await saveSharedEngineHostState({
			updaterConnected:false,updaterLastVerifiedAt:new Date().toISOString(),
			updaterLastError:'Custom License Manager Engine source temporarily unavailable.',lastError:null
		},current);
		return {host,synced:false,conflict:false,updateStarted:false,authorityUnavailable:true,fallback:'keep-current-release',latest:null,errorCode:String(error?.code||'ENGINE_SOURCE_UNAVAILABLE')};
	}


	const currentReleaseId=String(current.releaseId||'').trim();
	const currentVersion=String(current.releaseVersion||'').trim();
	const versionConflict=!currentReleaseId || currentReleaseId!==latest.descriptor.releaseId || currentVersion!==latest.descriptor.version;

	if(versionConflict) {
		const provisioned=await provisionSharedEngineHost({
			...input,
			releaseId:latest.descriptor.releaseId,
			releaseChannel:latest.descriptor.channel,
			reconcileToAuthority:true
		});
		return {
			host:provisioned,
			synced:false,
			conflict:true,
			updateStarted:true,
			latest:latest.descriptor,
			updatePlan:(provisioned as any)?.updatePlan||null
		};
	}

	const verified=await verifyAuthorizedEngineBranch({releaseId:currentReleaseId,sourceCommit:String(current.releaseSourceCommit||''),sha256:String(current.releaseSha256||'')});
	const host=await saveSharedEngineHostState({
		releaseChannel:verified.channel,
		updaterConnected:true,
		updaterConnectedAt:current.updaterConnectedAt||new Date().toISOString(),
		updaterProvider:verified.provider,
		updaterProtocol:verified.protocol,
		updaterLastVerifiedAt:verified.verifiedAt,
		updaterLastError:null
	},current);
	await recordLicenseManagerCheckIn({
		action:'check_in',
		phase:'completed',
		product:'orbitfs_base',
		productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
		releaseId:currentReleaseId,
		deploymentId:current.deploymentId,
		deploymentUrl:current.deploymentUrl,
		projectId:current.projectId,
		projectName:current.projectName,
		details:{
			deploymentProduct:'orbitfs_engine',
			engineVersion:current.releaseVersion,
			engineReady:true,
			updaterConnected:true,
			updaterProvider:verified.provider,
			updaterChannel:verified.channel,
			engineDeployerProtocol:verified.protocol,
			registrationSync:true
		}
	});
	return {host,synced:true,conflict:false,updateStarted:false,latest:latest.descriptor};
}

export async function refreshSharedEngineDeployment(input: Record<string, any> = {}) {
	const current = await getSharedEngineHostState();
	const pending = Boolean(current.pendingDeploymentId);
	const deploymentId = String(current.pendingDeploymentId || current.deploymentId || '').trim();
	if (!deploymentId) {
		return { host: current, ready: Boolean(current.releaseId && current.hostUrl), readyState: current.releaseId && current.hostUrl ? 'READY' : 'UNKNOWN', deployment: null };
	}
	const { token, teamId } = await credentialsFrom(input);
	if (!token) throw fail('Connect Vercel in OrbitFS before reading Shared Engine deployment status.', 409, 'VERCEL_TOKEN_REQUIRED');
	const deployment = await vercelRequest(`/v13/deployments/${encodeURIComponent(deploymentId)}`, token, teamId);
	const readyState = deploymentReadyState(deployment);
	const candidateDeploymentUrl = publicVercelUrl(deployment?.url) || current.pendingDeploymentUrl || current.deploymentUrl;
	const stableProjectUrl = current.projectName ? publicVercelUrl(`${current.projectName}.vercel.app`) : null;
	const preferredDomainUrl=current.domainMode!=='generated'&&current.domainVerified&&current.domainName?publicVercelUrl(current.domainName):null;
	const candidateHostUrl = preferredDomainUrl || stableProjectUrl || publicVercelUrl(deployment?.alias?.[0]) || candidateDeploymentUrl || current.hostUrl;

	const targetReleaseId = pending ? current.pendingReleaseId : current.releaseId;
	const targetVersion = pending ? current.pendingReleaseVersion : current.releaseVersion;
	const targetChannel = pending ? current.pendingReleaseChannel : current.releaseChannel;

	if (deploymentFailed(readyState)) {
		const hasActive = Boolean(current.releaseId && current.deploymentId && current.hostUrl);
		const detail = `Vercel deployment ended in ${readyState}. Any Engine database migrations already applied are forward-only and have NOT been rolled back; check database-status before retrying.`;
		const host = await saveSharedEngineHostState({
			state: hasActive ? (current.linkedAt ? 'ready' : 'deployed') : 'error',
			hostUrl: hasActive ? current.hostUrl : null,
			deploymentUrl: hasActive ? current.deploymentUrl : null,
			pendingDeploymentId:null,
			pendingDeploymentUrl:null,
			pendingReleaseVersion:null,
			pendingReleaseId:null,
			pendingReleaseChannel:null,
			pendingReleaseSha256:null,
			pendingReleaseSourceCommit:null,
			pendingReleaseFileCount:null,
			pendingReleaseInventory:null,
			pendingReleaseComponents:[],
			pendingReleaseComponentVersions:{},
			updaterConnected:hasActive ? current.updaterConnected : false,
			lastSyncAt:new Date().toISOString(),
			lastError:detail
		});
		await recordLicenseManagerCheckIn({
			action:'update',phase:'failed',product:'orbitfs_base',
			productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
			releaseId:targetReleaseId,deploymentId,
			deploymentUrl:candidateDeploymentUrl,
			projectId:current.projectId,projectName:current.projectName,
			details:{deploymentProduct:'orbitfs_engine',engineVersion:targetVersion,readyState}
		});
		throw Object.assign(new Error(detail), { status: 502, code: 'ENGINE_HOST_DEPLOYMENT_FAILED', host, readyState });
	}

	const ready = readyState === 'READY';
	if (ready) await ensureSelectedEngineVercelAliasOnDeployment(current,deploymentId,token,teamId);
	if (!ready) {
		const host = await saveSharedEngineHostState({
			state:'provisioning',
			pendingDeploymentUrl:candidateDeploymentUrl,
			hostUrl: current.hostUrl || candidateHostUrl,
			lastSyncAt:new Date().toISOString(),
			lastError:null
		});
		return { host, ready:false, readyState, deployment };
	}

	const gitBootstrapPending=current.distribution==='orbitfs-git-dev-v1';
	const branchPending=current.distribution==='orbitfs-authorized-branch-v1';
	if (
		pending &&
		(gitBootstrapPending || branchPending || Boolean(current.pendingReleaseInventory?.length)) &&
		current.pendingReleaseId &&
		current.pendingReleaseVersion &&
		current.pendingReleaseSha256
	) {
		const preFinalize = await saveSharedEngineHostState({
			state: current.linkedAt ? 'ready' : 'deployed',
			hostUrl:candidateHostUrl,
			pendingDeploymentUrl:candidateDeploymentUrl,
			lastSyncAt:new Date().toISOString(),
			lastError:null
		});
		const finalized = await finalizeReadyEngineRelease(preFinalize,{
			version:current.pendingReleaseVersion,
			releaseId:current.pendingReleaseId,
			channel:String(current.pendingReleaseChannel||env.ORBITFS_UPDATE_CHANNEL||'stable').trim().toLowerCase()||'stable',
			sha256:current.pendingReleaseSha256,
			sourceCommit:current.pendingReleaseSourceCommit,
			components:current.pendingReleaseComponents?.length?current.pendingReleaseComponents:Object.keys(current.pendingReleaseComponentVersions||{}),
			componentVersions:current.pendingReleaseComponentVersions||{},
			fileInventory:current.pendingReleaseInventory||[],
			deploymentId,
			deploymentUrl:candidateDeploymentUrl,
			verifyUpdater:!gitBootstrapPending,
			distribution:gitBootstrapPending?'orbitfs-git-dev-v1':branchPending?'orbitfs-authorized-branch-v1':'orbitfs-store-package-v1'
		});
		await recordLicenseManagerCheckIn({
			action:'update',phase:'completed',product:'orbitfs_base',
			productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
			releaseId:current.pendingReleaseId,deploymentId,
			deploymentUrl:candidateDeploymentUrl,
			projectId:current.projectId,projectName:current.projectName,
			details:{
				deploymentProduct:'orbitfs_engine',
				engineVersion:current.pendingReleaseVersion,
				readyState,
				targetComponents:current.pendingReleaseComponents||[],
				components:current.pendingReleaseComponentVersions||{},
				updaterConnected:finalized.updaterConnected
			}
		});
		return { host:finalized, ready:true, readyState, deployment };
	}

	const host = await saveSharedEngineHostState({
		state:['linked','ready'].includes(current.state)?'ready':'deployed',
		hostUrl:candidateHostUrl,
		deploymentUrl:candidateDeploymentUrl,
		lastSyncAt:new Date().toISOString(),
		lastError:null
	});

	if (current.releaseId && !current.updaterConnected && current.distribution!=='orbitfs-git-dev-v1') {
		try {
			const updater=current.distribution==='orbitfs-authorized-branch-v1'
				? await verifyAuthorizedEngineBranch({releaseId:current.releaseId,sourceCommit:String(current.releaseSourceCommit||''),sha256:String(current.releaseSha256||'')})
				: await verifyEngineUpdaterRelease({releaseId:current.releaseId,channel:String(targetChannel||env.ORBITFS_UPDATE_CHANNEL||'stable').trim().toLowerCase()||'stable'});
			const linked=await saveSharedEngineHostState({
				updaterConnected:true,
				updaterConnectedAt:current.updaterConnectedAt||new Date().toISOString(),
				updaterProvider:updater.provider,
				updaterProtocol:updater.protocol,
				updaterLastVerifiedAt:updater.verifiedAt,
				updaterLastError:null
			},host);
			await recordLicenseManagerCheckIn({
				action:'check_in',phase:'completed',product:'orbitfs_base',
				productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,
				releaseId:current.releaseId,deploymentId:current.deploymentId,
				deploymentUrl:current.deploymentUrl,projectId:current.projectId,projectName:current.projectName,
				details:{deploymentProduct:'orbitfs_engine',engineVersion:current.releaseVersion,engineReady:true,updaterConnected:true,updaterProvider:updater.provider,updaterChannel:updater.channel,engineDeployerProtocol:updater.protocol,reconnected:true}
			});
			return { host:linked, ready:true, readyState, deployment };
		} catch(error:any) {
			const disconnected=await saveSharedEngineHostState({
				updaterConnected:false,
				updaterLastVerifiedAt:new Date().toISOString(),
				updaterLastError:String(error?.message||'Updater verification failed')
			},host);
			return { host:disconnected, ready:true, readyState, deployment };
		}
	}

	return { host, ready:true, readyState, deployment };
}

export async function provisionSharedEngineHost(input: Record<string, any> = {}) {
	// The Shared Engine is infrastructure, but it is not free-standing: at least
	// one authoritative Engine add-on entitlement must exist before first deploy.
	// This check runs before Vercel/release work so a missing licence cannot leave
	// behind a half-created host project.
	const bootstrapEntitlement=await engineHostBootstrapEntitlement({activate:true,refresh:true});
	if(!bootstrapEntitlement.eligible){
		throw fail('At least one active OrbitFS add-on licence (MCP, APEX or Studio) is required before deploying the Shared Engine Host.',403,'ENGINE_ADDON_LICENSE_REQUIRED');
	}
	const { token, teamId } = await credentialsFrom(input);
	if (!token) throw fail('Connect Vercel in OrbitFS before deploying the Shared Engine Host.', 409, 'VERCEL_TOKEN_REQUIRED');
	let current = await getSharedEngineHostState();
	if(current.pendingDeploymentId){
		throw fail('A Shared Engine deployment is already in progress. Refresh its status instead of starting another deployment.',409,'ENGINE_DEPLOYMENT_IN_PROGRESS');
	}
	if(current.pendingReleaseId){
		const pendingAge=Date.now()-Date.parse(String(current.updatedAt||''));
		if(Number.isFinite(pendingAge)&&pendingAge<5*60_000){
			throw fail('A Shared Engine deployment is already being prepared. Refresh shortly instead of starting another deployment.',409,'ENGINE_DEPLOYMENT_PREPARING');
		}
		current=await saveSharedEngineHostState({
			state:current.releaseId?(current.linkedAt?'ready':'deployed'):'not_deployed',
			pendingDeploymentId:null,
			pendingDeploymentUrl:null,
			pendingReleaseVersion:null,
			pendingReleaseId:null,
			pendingReleaseChannel:null,
			pendingReleaseSha256:null,
			pendingReleaseSourceCommit:null,
			pendingReleaseFileCount:null,
			pendingReleaseInventory:null,
			pendingReleaseComponents:[],
			pendingReleaseComponentVersions:{},
			lastError:'Recovered an abandoned Engine deployment preparation.'
		},current);
	}
	const installation = await getInstallationRoute();
	const panelUrl = configuredPanelUrl();
	const name = current.projectName || projectName(current.installationId);
	// Base owns this inner deployer. Both first Engine installs and later Engine/add-on updates call this same authority-verified path.
	const releaseChannel=String(input.releaseChannel||input.channel||current.releaseChannel||env.ORBITFS_UPDATE_CHANNEL||'stable').trim().toLowerCase()||'stable';
	const requestedReleaseId=String(input.releaseId||'').trim();
	const requestedSourceCommit=String(input.sourceCommit||'').trim().toLowerCase();
	const requestedSourceMode=String(input.releaseSource||'').trim().toLowerCase();
	if(requestedSourceMode&&!['authorized-branch','published-update'].includes(requestedSourceMode)){
		throw fail('Unsupported Engine release source.',400,'ENGINE_RELEASE_SOURCE_INVALID');
	}
	const branchRelease=requestedReleaseId.startsWith('github:lucaskerim123/V1-vercel-engine@');
	const releaseSource=requestedSourceMode||(branchRelease?'authorized-branch':requestedReleaseId?'published-update':current.distribution==='orbitfs-store-package-v1'?'published-update':'authorized-branch');
	if(releaseSource==='authorized-branch'&&input.rollbackToCheckpoint===true&&!/^[a-f0-9]{40}$/.test(requestedSourceCommit)){
		throw fail('Engine branch rollback requires the previously authorized source commit recorded in its checkpoint.',409,'ENGINE_ROLLBACK_SOURCE_MISSING');
	}
	const publishedReleaseId=releaseSource==='published-update'?(requestedReleaseId||String(current.releaseId||'').trim()):'';
	if(releaseSource==='published-update'&&!publishedReleaseId){
		throw fail('A published Engine release ID is required for this deployment.',409,'ENGINE_RELEASE_ID_REQUIRED');
	}
	const authorityRelease=releaseSource==='published-update'
		?await fetchLatestEngineRelease({releaseId:publishedReleaseId,channel:releaseChannel})
		:await fetchAuthorizedEngineBranch(requestedSourceCommit?{sourceCommit:requestedSourceCommit}:{});
	const scoped=await scopeEngineReleaseForInstalledLicenses(authorityRelease,input.components);
	const release=scoped.release;
	const preparedAddons=scoped.preparedAddons;
	const deploymentDistribution=releaseSource==='published-update'?'orbitfs-store-package-v1':'orbitfs-authorized-branch-v1';
	if(requestedReleaseId && release.descriptor.releaseId!==requestedReleaseId)
		throw fail('Engine source does not match the requested release identity.',409,'ENGINE_SOURCE_STALE');
	if (release.installationId !== current.installationId) {
		throw fail('Engine release was authorized for a different OrbitFS installation.', 409, 'ENGINE_RELEASE_INSTALLATION_MISMATCH');
	}
	const descriptor = release.descriptor;
	const installedBaseVersion=await resolveInstalledBaseVersion();
	const databaseCredential=await prepareEngineDatabaseCredential();
	const databaseAccessContract=engineDatabaseRuntimeAccessContract();
	await repairEngineDatabaseRuntimeAccess(databaseCredential,databaseAccessContract);
	await assertEngineDatabaseAccess(databaseCredential,databaseAccessContract);
	const environmentVariables = await requiredEngineEnvironment({version:descriptor.version,releaseId:descriptor.releaseId,channel:descriptor.channel,projectName:name,baseVersion:installedBaseVersion,installationId:current.installationId},databaseCredential,databaseAccessContract);
	if (!current.releaseId) assertInitialEngineRelease(release);
	const databaseContract=await resolveEngineDatabaseContract(release,descriptor);
	const migrationState=await inspectEngineDatabaseMigrations(databaseContract.packageData,descriptor);
	let updatePlan = await buildEngineUpdatePlan({
		descriptor,
		package: release.package,
		installedBaseVersion,
		supportedProtocol: ENGINE_DEPLOYER_PROTOCOL
	});
	const releaseIdentityMatches=
		String(current.releaseId||'').trim()===descriptor.releaseId &&
		String(current.releaseVersion||'').trim()===descriptor.version;
	if(updatePlan.status==='noop'&&!releaseIdentityMatches){
		updatePlan={...updatePlan,status:'update',blocked:false,reason:null};
	}
	if (updatePlan.blocked) {
		const authorityReconcile=input.reconcileToAuthority===true;
		const downgradeOnly=authorityReconcile && String(updatePlan.reason||'').includes('downgrade requires an explicit rollback release');
		if(downgradeOnly){
			updatePlan={...updatePlan,status:'update',blocked:false,reason:'Updater authority differs from the registered Engine release; reconciling this installation to the current authoritative release.'};
		}else{
			throw fail(updatePlan.reason || 'Engine update is blocked by the installation state.', 409, 'ENGINE_UPDATE_BLOCKED');
		}
	}
	const deploymentBaselineHealthy=
		Boolean(current.projectId&&current.deploymentId&&current.hostUrl) &&
		['deployed','linked','ready'].includes(String(current.state||''));
	const cleanDeploymentNoOp=updatePlan.status==='noop'&&releaseIdentityMatches&&deploymentBaselineHealthy&&input.forceRedeploy!==true;
	const databaseMutationRequired=migrationState.missing.length>0;
	if (current.releaseId && (databaseMutationRequired||!cleanDeploymentNoOp) && input.actorUserId && input.actorUsername) {
		await createUpdateCheckpoint({
			actor: { id: String(input.actorUserId), username: String(input.actorUsername) },
			targetVersion: descriptor.version,
			reason: databaseMutationRequired&&cleanDeploymentNoOp?'pre-engine-database-migration':'pre-engine-update'
		});
	}
	const databaseMigrations=await applyEngineDatabaseMigrations(migrationState,descriptor);
	await repairEngineDatabaseRuntimeAccess(databaseCredential,databaseAccessContract);
	await assertEngineDatabaseAccess(databaseCredential,databaseAccessContract);
	if(cleanDeploymentNoOp){
		return { ...current, updatePlan, noOp: true, databaseMigrations };
	}
	if(updatePlan.status==='noop'&&(!deploymentBaselineHealthy||input.forceRedeploy===true)){
		updatePlan={...updatePlan,status:'update',blocked:false,reason:input.forceRedeploy===true?'Redeploying the current Engine release on request.':'The Engine release matches the updater baseline, but the deployed Host is incomplete or unhealthy and will be rebuilt.'};
	}
	const projectSettings = {
		framework: descriptor.projectSettings?.framework || release.package.projectSettings?.framework || 'sveltekit',
		buildCommand: descriptor.projectSettings?.buildCommand || release.package.projectSettings?.buildCommand || 'npm run build',
		installCommand: descriptor.projectSettings?.installCommand || release.package.projectSettings?.installCommand || 'npm ci',
		...(descriptor.projectSettings?.outputDirectory || release.package.projectSettings?.outputDirectory ? { outputDirectory: descriptor.projectSettings?.outputDirectory || release.package.projectSettings?.outputDirectory } : {})
	};

	await saveSharedEngineHostState({
		state: 'provisioning', installationRoute: installation.route, panelUrl, projectName: name, distribution: deploymentDistribution,
		pendingDeploymentId:null,
		pendingDeploymentUrl:null,
		pendingReleaseVersion:descriptor.version,
		pendingReleaseId:descriptor.releaseId,
		pendingReleaseChannel:descriptor.channel,
		pendingReleaseSha256:descriptor.sha256,
		pendingReleaseSourceCommit:descriptor.sourceCommit,
		pendingReleaseFileCount:descriptor.fileCount,
		pendingReleaseInventory: release.package.files.map((file: any) => ({ file: file.file, component: String(file.component || 'shared'), sha256: String(file.sha256 || ''), size: Number(file.size || 0) })),
		pendingReleaseComponents: descriptor.components || [],
		pendingReleaseComponentVersions: release.package.componentVersions || {},
		updaterConnected:false,
		updaterLastError:null,
		lastError: null
	});

	try {
		if (current.releaseId && !current.projectId) {
			throw fail('This Shared Engine is already installed but its Vercel project id is missing. OrbitFS will not create a replacement project during an update.', 409, 'ENGINE_PROJECT_ID_REQUIRED');
		}
		let project: any = null;
		if (current.projectId) {
			try {
				project = await vercelRequest(`/v9/projects/${encodeURIComponent(current.projectId)}`, token, teamId);
			} catch (error: any) {
				if (Number(error?.status) === 404) {
					throw fail('The registered Shared Engine Vercel project no longer exists. OrbitFS will not create a new project during an update.', 409, 'ENGINE_PROJECT_NOT_FOUND');
				}
				throw error;
			}
		}
		if (!project) {
			const createBody=JSON.stringify({name,...projectSettings});
			let createError:any=null;
			for(const endpoint of ['/v11/projects','/v10/projects','/v9/projects']){
				try{
					project=await vercelRequest(endpoint,token,teamId,{method:'POST',body:createBody});
					createError=null;
					break;
				}catch(error:any){
					createError=error;
					const status=Number(error?.status||0);
					if(status===404)continue;
					if(status!==409)throw error;
					break;
				}
			}
			if(!project){
				if(Number(createError?.status)!==409)throw createError||fail('Vercel project creation failed.',503,'VERCEL_PROJECT_CREATE_FAILED');
				if(!current.projectId) {
					// The deterministic project may already exist from an interrupted
					// first deployment before OrbitFS persisted its project id. Re-adopt
					// only that exact generated project inside the connected account/team.
					project = await vercelRequest(`/v9/projects/${encodeURIComponent(name)}`, token, teamId);
					if(String(project?.name||'').trim()!==name) {
						throw fail(
							`A conflicting Vercel project exists for ${name}, but it could not be safely adopted.`,
							409,
							'VERCEL_ENGINE_PROJECT_NAME_CONFLICT'
						);
					}
					current=await saveSharedEngineHostState({projectId:String(project.id||'')||null,projectName:name,lastError:null},current);
				} else {
					project = await vercelRequest(`/v9/projects/${encodeURIComponent(current.projectId)}`, token, teamId);
				}
			}
		}
		const projectId = String(project?.id || current.projectId || '').trim();
		if (!projectId) throw fail('Vercel did not return the Shared Engine project id.', 503, 'VERCEL_PROJECT_ID_MISSING');

		const desiredEnvironmentKeys=new Set(environmentVariables.map((item)=>item.key));
		await removeProjectEnvironmentKeys(
			projectId,
			['SUPABASE_SECRET_KEY','ORBITFS_DB_SECRET'].filter((key)=>!desiredEnvironmentKeys.has(key)),
			token,
			teamId
		);
		await upsertProjectEnvironment(projectId,environmentVariables,token,teamId);

		const files = await uploadReleaseFiles(release.files, token, teamId);
		const deploymentBody:any={
			name,
			project: projectId,
			target: 'production',
			projectSettings,
			meta: {
				orbitfsDistribution: deploymentDistribution,
				orbitfsInstallationId: current.installationId,
				orbitfsReleaseVersion: descriptor.version,
				orbitfsReleaseId: descriptor.releaseId,
				orbitfsEngineDeployerProtocol: String(ENGINE_DEPLOYER_PROTOCOL),
				installationRoute: installation.route
			}
		};
		deploymentBody.files=files;
		const deployment = await vercelRequest('/v13/deployments', token, teamId, {
			method: 'POST',
			body: JSON.stringify(deploymentBody)
		});
		const readyState = deploymentReadyState(deployment);
		const effectiveSourceCommit=descriptor.sourceCommit;
		const effectiveSha256=descriptor.sha256;
		await recordLicenseManagerCheckIn({action:'update',phase:'started',product:'orbitfs_base',productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,releaseId:descriptor.releaseId,deploymentId:String(deployment?.id||'')||null,deploymentUrl:publicVercelUrl(deployment?.url),projectId,projectName:name,details:{deploymentProduct:'orbitfs_engine',engineVersion:descriptor.version,readyState,targetComponents:descriptor.components,components:release.package.componentVersions||{},preparedAddons,databasePackageSource:databaseContract.source,databasePackages:databaseContract.packages,databaseMigrations:databaseMigrations.map((migration:any)=>({id:migration.id,file:migration.file,component:migration.component,sha256:migration.sha256}))}});
		const aliases = Array.isArray(deployment?.alias) ? deployment.alias : [];
		const hostUrl = publicVercelUrl(aliases[0] || project?.alias?.[0] || `${name}.vercel.app`);
		const deploymentUrl = publicVercelUrl(deployment?.url);
		const savedHost = await saveSharedEngineHostState({
			state: readyState === 'READY' ? 'deployed' : 'provisioning', installationRoute: installation.route, panelUrl, hostUrl, projectId, projectName: name,
			distribution: deploymentDistribution,
			pendingDeploymentId:String(deployment?.id||'')||null,
			pendingDeploymentUrl:deploymentUrl,
			pendingReleaseVersion:descriptor.version,
			pendingReleaseId:descriptor.releaseId,
			pendingReleaseChannel:descriptor.channel,
			pendingReleaseSha256:effectiveSha256,
			pendingReleaseSourceCommit:effectiveSourceCommit,
			pendingReleaseFileCount:descriptor.fileCount,
			// Keep the candidate inventory until READY so refreshSharedEngineDeployment()
			// can atomically promote this exact release into the active updater state.
			pendingReleaseInventory: release.package.files.map((file: any) => ({ file: file.file, component: String(file.component || 'shared'), sha256: String(file.sha256 || ''), size: Number(file.size || 0) })),
			pendingReleaseComponents: descriptor.components || [],
			pendingReleaseComponentVersions: release.package.componentVersions || {},
			updaterConnected:false,
			updaterLastError:null,
			lastError: null, lastSyncAt: new Date().toISOString()
		});
		if (readyState === 'READY') {
			await ensureSelectedEngineVercelAliasOnDeployment(current,String(deployment?.id||''),token,teamId);
			const finalized=await finalizeReadyEngineRelease(savedHost,{
				version:descriptor.version,
				releaseId:descriptor.releaseId,
				channel:descriptor.channel,
				sha256:effectiveSha256,
				sourceCommit:effectiveSourceCommit,
				components:descriptor.components,
				componentVersions:release.package.componentVersions||{},
				fileInventory:release.package.files.map((file:any)=>({file:file.file,component:String(file.component||'shared'),sha256:String(file.sha256||''),size:Number(file.size||0)})),
				deploymentId:String(deployment?.id||'')||null,
				deploymentUrl,
				verifyUpdater:true,
				distribution:deploymentDistribution
			});
			await recordLicenseManagerCheckIn({action:'update',phase:'completed',product:'orbitfs_base',productVersion:String(env.ORBITFS_APP_VERSION||'').trim()||null,releaseId:descriptor.releaseId,deploymentId:String(deployment?.id||'')||null,deploymentUrl,projectId,projectName:name,details:{deploymentProduct:'orbitfs_engine',engineVersion:descriptor.version,readyState,targetComponents:descriptor.components,components:release.package.componentVersions||{},updaterConnected:finalized.updaterConnected}});
			return { ...finalized, updatePlan, databaseMigrations };
		}
		return { ...savedHost, updatePlan, databaseMigrations };
	} catch (error: any) {
		const detail = String(error?.message || 'Shared Engine Host provisioning failed.');
		if(databaseMigrations.length){
			const partialDetail=`Engine database migrations were applied, but the Engine deployment failed: ${detail}. Database changes are forward-only; retry the same pinned Engine source after resolving the deployment error.`;
			await saveSharedEngineHostState({state:'error',lastError:partialDetail,updaterConnected:false}).catch(()=>undefined);
			throw fail(partialDetail,503,'ENGINE_DEPLOYMENT_PARTIAL_DB_APPLIED');
		}
		if(String(error?.code||'')==='ENGINE_UPDATER_REGISTRATION_FAILED'){
			const latestState=await getSharedEngineHostState().catch(()=>current);
			await saveSharedEngineHostState({
				state:latestState.hostUrl?'deployed':'error',
				updaterConnected:false,
				updaterLastVerifiedAt:new Date().toISOString(),
				updaterLastError:detail,
				lastError:detail
			},latestState).catch(()=>undefined);
			throw Object.assign(error instanceof Error?error:new Error(detail),{message:detail});
		}
		const fallbackState = current.releaseId && current.hostUrl ? current.state : 'error';
		await saveSharedEngineHostState({
			state:fallbackState,
			pendingDeploymentId:null,
			pendingDeploymentUrl:null,
			pendingReleaseVersion:null,
			pendingReleaseId:null,
			pendingReleaseChannel:null,
			pendingReleaseSha256:null,
			pendingReleaseSourceCommit:null,
			pendingReleaseFileCount:null,
			pendingReleaseInventory:null,
			pendingReleaseComponents:[],
			pendingReleaseComponentVersions:{},
			updaterConnected:current.updaterConnected===true,
			updaterLastError:current.updaterLastError||null,
			lastError:detail
		}).catch(() => undefined);
		throw Object.assign(error instanceof Error ? error : new Error(detail), { message: detail });
	}
}