<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { addons as addonsStore } from '$lib/addons.svelte';
	import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '$lib/components/ui';
	import { ExternalLink, LoaderCircle, PlugZap, Puzzle, RefreshCw, Server, Trash2, Unplug, X } from '@lucide/svelte';

	type Addon = {
		id:string; name:string; description:string; version:string;
		installed:boolean; attached:boolean; recordAttached?:boolean;
		licensed:boolean; licenseAllowed?:boolean; licenseReason?:string|null;
		available:boolean; status:string; engineManageUrl?:string|null;
		setupComplete?:boolean; needsSetup?:boolean; setupState?:string; installStatus?:string;
	};
	type Host = {
		state:string; hostUrl:string|null; projectName:string|null; projectId:string|null;
		lastError:string|null; releaseVersion?:string|null; releaseId?:string|null; releaseChannel?:string|null;
		updaterConnected?:boolean; updaterProvider?:string|null; updaterProtocol?:number|null;
		updaterLastVerifiedAt?:string|null; updaterLastError?:string|null;
		domainMode?:'generated'|'vercel'|'custom'; domainName?:string|null; domainVerified?:boolean;
	};
	type EngineDomainDnsRecord = {type:'A'|'CNAME'|'TXT';name:string;hostname:string;value:string;purpose:'routing'|'verification'};
	type EngineDomainDns = {
		domain:string;apexName:string|null;ownershipVerified:boolean;dnsConfigured:boolean|null;
		ready:boolean;records:EngineDomainDnsRecord[];hasRoutingRecommendation:boolean;
		verificationError?:string|null;checkedAt:string;
	};
	type HostResponse = { host:Host; provisioningAvailable:boolean; provisioningMissing?:string[]; waiting?:boolean; dns?:EngineDomainDns|null };
	type EngineUpdatePlan = {
		status:'install'|'update'|'noop'|'blocked'; blocked:boolean; reason:string|null;
		current?:{version:string|null;releaseId:string|null;fileCount:number}|null;
		target:{version:string;releaseId:string;components:string[];fileCount:number};
		changes:{added:string[];modified:string[];removed:string[];unchanged:string[]};
		componentChanges:Array<{component:string;from:string|null;to:string|null}>;
		baseCompatibility:{required:string|null;installed:string|null;compatible:boolean};
	};
	type EnginePlanResponse = { ok:boolean; plan:EngineUpdatePlan; release:{version:string;id:string;checksum:string;channel?:string} };

	let addons=$state<Addon[]>([]);
	let host=$state<Host|null>(null);
	let provisioningAvailable=$state(false);
	let provisioningMissing=$state<string[]>([]);
	let loading=$state(true);
	let busy=$state('');
	let error=$state('');
	let polling=$state(false);
	let showVercelConnection=$state(false);
	let vercelToken=$state('');
	let vercelTeamId=$state('');
	let connectingVercel=$state(false);
	let enginePlan=$state<EnginePlanResponse|null>(null);
	let showEngineDomain=$state(false);
	let engineDomainMode=$state<'generated'|'vercel'|'custom'>('generated');
	let engineDomain=$state('');
	let engineDomainAvailability=$state<{domain:string;available:boolean;attached?:boolean;reserved?:boolean;reason?:string|null}|null>(null);
	let engineDomainDns=$state<EngineDomainDns|null>(null);
	let engineDomainDnsError=$state('');
	let engineDomainDnsLoading=$state(false);
	let dnsCopyMessage=$state('');

	const message=(e:unknown,fallback:string)=>e instanceof ApiError?`${e.message}${e.code?` (${e.code})`:''}`:fallback;
	const hostReady=()=>['linked','ready'].includes(String(host?.state||''));
	const hostAdvancing=()=>['provisioning','deployed','linking'].includes(String(host?.state||''))&&!hostReady();
	const hostLabel=()=>String(host?.state||'not_deployed').replaceAll('_',' ');
	const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));
	const recordAttached=(a:Addon)=>a.recordAttached===true||a.attached===true;
	const engineUrl=(a:Addon)=>a.engineManageUrl||(host?.hostUrl?`${host.hostUrl}/engines/${a.id}`:'');
	
	function availability(a:Addon){
		if(!a.available)return 'Unavailable';
		if(a.licenseAllowed===false)return 'Not licensed';
		if(recordAttached(a)&&a.licensed&&a.needsSetup)return 'Setup required';
		if(a.installStatus==='installing')return 'Installing';
		if(recordAttached(a)&&a.licensed)return 'Linked';
		if(a.installed)return 'Installed';
		return 'Available';
	}
	function tone(a:Addon){
		if(!a.available||a.licenseAllowed===false)return 'destructive';
		if(recordAttached(a)&&a.licensed)return 'success';
		return 'secondary';
	}

	async function load(startPolling=true,clearError=true){
		loading=true; if(clearError)error='';
		try{
			const [addonData,hostData]=await Promise.all([
				api.get<{addons:Addon[]}>('/addons'),
				api.get<HostResponse>('/engine-host')
			]);
			addons=addonData.addons;
			host=hostData.host;
			if(host?.domainMode==='custom'&&host.domainName){
				if(!engineDomainDns||engineDomainDns.domain!==host.domainName)void loadEngineDomainDns();
			}else{engineDomainDns=null;engineDomainDnsError='';}
			provisioningAvailable=hostData.provisioningAvailable;
			provisioningMissing=hostData.provisioningMissing||[];
			if(startPolling&&hostAdvancing()&&provisioningAvailable)void pollHost();
		}catch(e){ error=message(e,'Could not load Add-on Library'); }
		finally{ loading=false; }
	}
	load();

	async function pollHost(){
		if(polling)return;
		polling=true;
		try{
			for(let i=0;i<120;i+=1){
				if(hostReady()||host?.state==='error'||!hostAdvancing())break;
				await sleep(60_000);
				try{
					const data=await api.post<HostResponse>('/engine-host/refresh');
					host=data.host;
					provisioningAvailable=data.provisioningAvailable;
			provisioningMissing=data.provisioningMissing||[];
					if(hostReady()||host?.state==='error'||data.waiting===false)break;
				}catch(e){ error=message(e,'Could not refresh Engine deployment'); break; }
			}
		}finally{
			polling=false;
			await load(false);
			await addonsStore.load();
		}
	}

	async function connectVercelAndDeploy(e:Event){
		e.preventDefault();
		connectingVercel=true; error='';
		try{
			await api.post('/vercel-connection',{token:vercelToken,teamId:vercelTeamId||null});
			vercelToken=''; vercelTeamId=''; showVercelConnection=false;
			const deployed=await hostAct('provision');
			if(!deployed)throw new Error(error||'Engine deployment failed');
		}catch(e){ if(!error)error=message(e,'Could not connect Vercel or deploy the Engine'); }
		finally{ connectingVercel=false; }
	}

	async function loadEngineDomainDns(){
		if(!host?.projectId||host.domainMode!=='custom'||!host.domainName){engineDomainDns=null;return;}
		engineDomainDnsLoading=true;engineDomainDnsError='';
		try{
			const result=await api.get<{dns:EngineDomainDns|null}>('/engine-host/domain-dns');
			engineDomainDns=result.dns||null;
		}catch(e){engineDomainDns=null;engineDomainDnsError=message(e,'Unable to get DNS instructions from Vercel.');}
		finally{engineDomainDnsLoading=false;}
	}

	async function copyDns(value:string){
		try{await navigator.clipboard.writeText(value);dnsCopyMessage='Copied to clipboard.';}
		catch{dnsCopyMessage='Select the record value and copy it manually.';}
	}

	function toggleEngineDomain(){
		showEngineDomain=!showEngineDomain;
		if(!showEngineDomain)return;
		engineDomainMode=host?.domainMode==='custom'?'custom':host?.domainMode==='vercel'?'vercel':'generated';
		engineDomain=host?.domainName||'';
		engineDomainAvailability=engineDomainMode==='vercel'&&engineDomain?{domain:engineDomain,available:true,reserved:true,attached:true}:null;
		if(engineDomainMode==='custom'&&!engineDomainDns&&!engineDomainDnsLoading)void loadEngineDomainDns();
	}

	async function refreshEngineDomain(){
		if(!host?.projectId)return;
		busy='host:domain'; error='';
		try{
			const data=host.domainMode==='custom'
				?await api.post<HostResponse>('/engine-host/domain-refresh',{})
				:await api.get<HostResponse>('/engine-host');
			host=data.host;
			provisioningAvailable=data.provisioningAvailable;
			provisioningMissing=data.provisioningMissing||[];
			if(host?.domainMode==='custom') {engineDomainDns=data.dns||null;engineDomainDnsError='';}
			else {engineDomainDns=null;engineDomainDnsError='';}
			if(host?.domainMode==='vercel'&&host.domainName)engineDomainAvailability={domain:host.domainName,available:true,attached:true,reserved:true};
		}catch(e){ error=message(e,'Could not refresh Engine domain status'); }
		finally{ busy=''; }
	}

	async function checkEngineDomainAvailability(){
		if(!engineDomain.trim())return null;
		busy='host:domain-check'; error='';
		try{
			const data=await api.post<any>('/engine-host/domain-check',{domain:engineDomain});
			if(data.host)host=data.host;
			engineDomainAvailability=data.availability||null;
			if(data.availability?.domain)engineDomain=data.availability.domain;
			return data.availability||null;
		}catch(e){
			engineDomainAvailability=null;
			error=message(e,'Could not check the Engine Vercel address');
			return null;
		}finally{ busy=''; }
	}

	async function saveEngineDomain(){
		if(!host?.projectId)return;
		if(engineDomainMode==='vercel'){
			const availability=await checkEngineDomainAvailability();
			if(!availability?.available)return;
		}
		busy='host:domain'; error='';
		try{
			const data=await api.post<any>('/engine-host/domain',{mode:engineDomainMode,domain:engineDomainMode==='generated'?null:engineDomain});
			host=data.host;
			engineDomainMode=host?.domainMode==='custom'?'custom':host?.domainMode==='vercel'?'vercel':'generated';
			engineDomain=host?.domainName||'';
			engineDomainAvailability=engineDomainMode==='vercel'&&engineDomain?{domain:engineDomain,available:true,attached:true,reserved:true}:null;
			showEngineDomain=false;
			if(host?.domainMode==='custom')await loadEngineDomainDns();
			else {engineDomainDns=null;engineDomainDnsError='';}
		}catch(e){ error=message(e,'Could not update the Engine address'); }
		finally{ busy=''; }
	}

	async function hostAct(action:string,body:Record<string,unknown>={}){
		busy=`host:${action}`; error='';
		let ok=false;
		try{
			const data=await api.post<HostResponse>(`/engine-host/${action}`,body);
			host=data.host;
			provisioningAvailable=data.provisioningAvailable;
			provisioningMissing=data.provisioningMissing||[];
			if(['provision','refresh','link'].includes(action)&&hostAdvancing())void pollHost();
			ok=true;
		}catch(e){ error=message(e,`Engine ${action} failed`); }
		finally{ busy=''; await load(false,false); }
		return ok;
	}

	async function syncEngineUpdater(){
		busy='host:register'; error='';
		try{
			const data=await api.post<any>('/engine-host/register');
			host=data.host;
			if(data.waiting===true||data.updaterSync?.updateStarted===true)void pollHost();
		}catch(e){ error=message(e,'Could not register or sync the Engine updater'); }
		finally{ busy=''; await load(false,false); }
	}

	async function checkEngineUpdate(){
		busy='host:plan'; error='';
		try{
			enginePlan=await api.post<EnginePlanResponse>('/engine-host/plan');
		}catch(e){ enginePlan=null; error=message(e,'Could not check for Engine updates'); }
		finally{ busy=''; }
	}

	async function applyEngineUpdate(){
		if(!enginePlan?.release?.id)return;
		if(enginePlan.plan.blocked){ error=enginePlan.plan.reason||'This Engine update is blocked.'; return; }
		if(enginePlan.plan.status==='noop')return;
		const target=enginePlan.release;
		enginePlan=null;
		await hostAct('provision',{releaseId:target.id,releaseChannel:target.channel||undefined});
	}

	async function addonAct(id:string,action:'install'|'link'|'unlink'|'test'){
		busy=`${id}:${action}`; error='';
		try{
			const endpoint=`/addon-library/${id}/${action}`;
			const data=await api.post<any>(endpoint);
			if(action==='install'&&data?.host){
				host=data.host;
				if(data.waiting===true||hostAdvancing())void pollHost();
			}
			await load(false);
			await addonsStore.load();
		}catch(e){ error=message(e,`${action} failed`); }
		finally{ busy=''; }
	}

	async function remove(id:string){
		const addon=addons.find((item)=>item.id===id);
		if(!confirm(`Uninstall ${addon?.name||id}? If linked, it will first be detached from the Shared Engine. Your database, addon data and files will be preserved.`))return;
		busy=`${id}:remove`; error='';
		try{
			if(addon && recordAttached(addon)) await api.post(`/addon-library/${id}/unlink`);
			await api.delete(`/addon-library/${id}`);
			await load(false);
			await addonsStore.load();
		}catch(e){ error=message(e,'Uninstall failed. No addon data was deleted.'); }
		finally{ busy=''; }
	}

	async function uninstallEngine(){
		if(!host?.projectId||!host.projectName)return;
		const installed=addons.filter((addon)=>addon.installed&&recordAttached(addon));
		if(installed.length){
			error=`Detach or uninstall attached addons first: ${installed.map((addon)=>addon.name).join(', ')}.`;
			return;
		}
		if(!confirm(`Uninstall the Shared Engine and delete its Vercel project "${host.projectName}"?\n\nThis removes the Engine deployment and clears its update state. Your Supabase database and addon data will be preserved.\n\nContinue?`))return;
		busy='host:uninstall'; error='';
		try{
			await api.post('/engine-host/uninstall',{confirmProjectName:host.projectName,confirmProjectId:host.projectId,preserveDatabase:true});
			enginePlan=null;
			await load(false);
			await addonsStore.load();
		}catch(e){ error=message(e,'Engine uninstall failed; check Vercel and refresh before retrying.'); }
		finally{ busy=''; }
	}
</script>

<div class="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-6">
	<header class="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-4">
		<div>
			<div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.16em] text-primary"><Puzzle class="size-4"/> Add-on Library</div>
			<h1 class="mt-1 text-2xl font-semibold">OrbitFS Add-on Library</h1>
			<p class="text-sm text-muted-foreground">Deployment order is fixed: Inner Deploy → Shared Engine → licensed plugin. Plugins never create or replace the shared host.</p>
		</div>
		<Button variant="outline" onclick={()=>load()} disabled={loading||polling}><RefreshCw class="size-4"/>Refresh</Button>
	</header>

	{#if error}<div class="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}

	{#if loading}
		<div class="grid min-h-64 place-items-center"><LoaderCircle class="size-7 animate-spin"/></div>
	{:else}
		<Card>
			<CardHeader>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div><CardTitle>Shared OrbitFS Engine</CardTitle><CardDescription>One shared Engine deployment runs all licensed plugins for this customer. Deploy it before installing any plugin.</CardDescription></div>
					<Badge variant={hostReady()?'success':host?.state==='error'?'destructive':'outline'}>{hostLabel()}</Badge>
				</div>
			</CardHeader>
			<CardContent class="space-y-3">
				<div class="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
					<div class="rounded-lg border p-3"><span class="text-xs text-muted-foreground">Host</span><p class="mt-1 break-all font-medium">{host?.hostUrl||'Not deployed'}</p></div>
					<div class="rounded-lg border p-3"><span class="text-xs text-muted-foreground">Project</span><p class="mt-1 break-all font-medium">{host?.projectName||host?.projectId||'—'}</p></div>
					<div class="rounded-lg border p-3"><span class="text-xs text-muted-foreground">Panel link</span><p class="mt-1 font-medium">{hostReady()?'Linked':polling?'Linking…':'Not linked'}</p></div>
					<div class="rounded-lg border p-3"><span class="text-xs text-muted-foreground">Updater</span><p class="mt-1 font-medium">{host?.updaterConnected?'Connected':host?.hostUrl?'Needs connection':'Not deployed'}</p>{#if host?.releaseVersion}<p class="mt-1 text-xs text-muted-foreground">{host.releaseVersion} · {host.releaseChannel||'stable'}</p>{/if}</div>
				</div>
				{#if host?.projectId}
					<div class="rounded-lg border bg-muted/15 p-3">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="text-xs font-semibold uppercase tracking-[.12em] text-primary">Domain &amp; address</p>
								<p class="mt-1 break-all text-sm font-medium">{host.hostUrl||'No Engine address detected'}</p>
								{#if host.hostUrl}<p class="mt-1 break-all text-xs"><span class="text-muted-foreground">MCP connector:</span> <a class="font-medium underline underline-offset-2" href={`${host.hostUrl}/mcp`} target="_blank" rel="noreferrer">{host.hostUrl}/mcp</a></p>{/if}
								{#if host.projectName&&host.hostUrl!==`https://${host.projectName}.vercel.app`}<p class="mt-1 break-all text-xs text-muted-foreground">Original MCP address remains available: https://{host.projectName}.vercel.app/mcp</p>{/if}
								<p class="mt-1 text-xs text-muted-foreground">{host.domainMode==='custom'?(host.domainVerified?'Custom domain verified and active.':'Custom domain attached; Vercel DNS verification is still required.'):host.domainMode==='vercel'?`Using reserved Vercel address ${host.domainName||host.hostUrl}.`:'Using the stable generated Vercel domain.'}</p>
							</div>
							<div class="flex flex-wrap gap-2">
								<Button variant="outline" size="sm" onclick={refreshEngineDomain} disabled={busy!==''}>{busy==='host:domain'?'Checking…':'Refresh domain'}</Button>
								<Button variant="outline" size="sm" onclick={toggleEngineDomain} disabled={busy!==''}>{showEngineDomain?'Close':'Configure'}</Button>
							</div>
						</div>
						{#if showEngineDomain}
							<div class="mt-3 grid gap-3 border-t pt-3 md:grid-cols-[220px_minmax(0,1fr)_auto] md:items-end">
								<label class="grid gap-1.5 text-sm">
									<span class="font-medium">Address type</span>
									<select class="h-9 rounded-md border border-input bg-background px-3 text-sm" bind:value={engineDomainMode} onchange={()=>engineDomainAvailability=null} disabled={busy!==''}>
										<option value="generated">Default generated Vercel domain</option>
										<option value="vercel">Custom Vercel address</option>
										<option value="custom">Custom domain</option>
									</select>
								</label>
								{#if engineDomainMode==='vercel'}
									<label class="grid gap-1.5 text-sm">
										<span class="font-medium">Custom Vercel address</span>
										<Input bind:value={engineDomain} oninput={()=>engineDomainAvailability=null} placeholder="my-orbitfs-engine.vercel.app" autocomplete="off"/>
										<span class="text-xs text-muted-foreground">Check availability first. Nothing is claimed until you save the address.</span>
									</label>
								{:else if engineDomainMode==='custom'}
									<label class="grid gap-1.5 text-sm">
										<span class="font-medium">Custom Engine domain</span>
										<Input bind:value={engineDomain} placeholder="engine.example.com" autocomplete="off"/>
									</label>
								{:else}
									<div class="rounded-md border bg-background/60 px-3 py-2 text-sm">
										<span class="text-xs text-muted-foreground">Generated address</span>
										<p class="mt-1 break-all font-medium">https://{host.projectName}.vercel.app</p>
									</div>
								{/if}
								<div class="flex flex-wrap gap-2">
									{#if engineDomainMode==='vercel'}<Button variant="outline" onclick={checkEngineDomainAvailability} disabled={busy!==''||!engineDomain.trim()}>{busy==='host:domain-check'?'Checking…':'Check availability'}</Button>{/if}
									<Button onclick={saveEngineDomain} disabled={busy!==''||(engineDomainMode!=='generated'&&!engineDomain.trim())}>{busy==='host:domain'?'Saving…':'Save address'}</Button>
								</div>
							</div>
							{#if engineDomainMode==='vercel'&&engineDomainAvailability}
							<p class={engineDomainAvailability.available?'mt-2 text-xs text-emerald-500':'mt-2 text-xs text-destructive'}>
								<strong>{engineDomainAvailability.available?'Available':'Unavailable'}:</strong> {engineDomainAvailability.domain}{engineDomainAvailability.available?(engineDomainAvailability.attached?' is already attached to this Engine project.':' is available and will only be claimed when you save.'):' is already in use on Vercel.'}
							</p>
						{/if}
						{#if engineDomainMode==='custom'}
							<p class="mt-2 text-xs text-muted-foreground">Save the domain first to attach it to the existing Vercel project. OrbitFS will then show exactly which DNS records to add at your DNS provider.</p>
						{:else}
							<p class="mt-2 text-xs text-muted-foreground">Generated and vercel.app addresses do not require DNS records at your domain registrar.</p>
						{/if}
						<p class="mt-2 text-xs text-muted-foreground">This changes the address on the existing Shared Engine Vercel project. It does not create a second Engine deployment.</p>
						{/if}
					</div>
				{/if}
				{#if host?.domainMode==='custom' && host.domainName}
					<div class="rounded-lg border p-4 text-sm">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div><p class="font-semibold">DNS records for {host.domainName}</p><p class="mt-1 text-xs text-muted-foreground">Add these records at the company managing your domain's DNS, not in OrbitFS. Values are retrieved from Vercel for this Engine project.</p></div>
							<Button variant="outline" size="sm" onclick={refreshEngineDomain} disabled={busy!==''}>{busy==='host:domain'?'Verifying…':'Check DNS & verify'}</Button>
						</div>
						{#if engineDomainDnsLoading}<p class="mt-3 text-xs text-muted-foreground">Loading exact DNS records from Vercel…</p>{/if}
						{#if engineDomainDnsError}<p class="mt-3 text-xs text-destructive">{engineDomainDnsError}</p><p class="mt-1 text-xs text-muted-foreground">Open Configure, then Refresh domain to retry. No example DNS values have been substituted.</p>{/if}
						{#if engineDomainDns}
							<div class="mt-3 flex flex-wrap gap-2 text-xs">
								<span class="rounded-md border px-2 py-1">Ownership: {engineDomainDns.ownershipVerified?'Verified':'Pending'}</span>
								<span class="rounded-md border px-2 py-1">DNS routing: {engineDomainDns.dnsConfigured===true?'Configured':engineDomainDns.dnsConfigured===false?'Needs attention':'Not confirmed'}</span>
								<span class="rounded-md border px-2 py-1">Custom address: {engineDomainDns.ready?'Ready':'Not ready'}</span>
							</div>
							{#if engineDomainDns.records.length}
								<div class="mt-3 overflow-x-auto rounded-md border">
									<table class="w-full min-w-[490px] text-left text-xs">
										<thead class="bg-muted/40"><tr><th class="p-2">Type</th><th class="p-2">Name / Host</th><th class="p-2">Value / Target</th><th class="p-2">Copy</th></tr></thead>
										<tbody>{#each engineDomainDns.records as record}
											<tr class="border-t align-top">
												<td class="p-2 font-semibold">{record.type}<div class="font-normal text-muted-foreground">{record.purpose==='verification'?'Verify ownership':'Route traffic'}</div></td>
												<td class="p-2"><code class="break-all">{record.name}</code><div class="text-muted-foreground">Full: {record.hostname}</div></td>
												<td class="p-2"><code class="break-all select-all">{record.value}</code></td>
												<td class="p-2"><Button variant="outline" size="sm" onclick={()=>copyDns(record.value)}>Copy value</Button></td>
											</tr>
										{/each}</tbody>
									</table>
								</div>
								<p class="mt-2 text-xs text-muted-foreground">At your DNS provider, select the listed Type and enter Name/Host and Value/Target exactly as shown. If your provider requires a fully qualified host, use the Full name under the record. Remove conflicting records for the same host and type only after checking what they currently serve.</p>
							{/if}
							{#if !engineDomainDns.hasRoutingRecommendation}
								<p class="mt-3 text-xs text-destructive">Vercel has not returned a routing DNS value for this domain. Do not enter a guessed A or CNAME target. Check this project's Domains settings on Vercel, then retry.</p>
							{/if}
							{#if engineDomainDns.verificationError}<p class="mt-2 text-xs text-muted-foreground">Vercel verification: {engineDomainDns.verificationError}</p>{/if}
							<p class="mt-2 text-xs text-muted-foreground">{engineDomainDns.ready?'Vercel confirms DNS routing and domain ownership.':'After adding the records, allow DNS to propagate, then press Check DNS & verify. The generated vercel.app address remains the fallback until verification succeeds.'}</p>
						{:else if !engineDomainDnsLoading&&!engineDomainDnsError}
							<p class="mt-3 text-xs text-muted-foreground">Press Check DNS & verify to fetch the records required by Vercel.</p>
						{/if}
						{#if dnsCopyMessage}<p class="mt-2 text-xs text-muted-foreground">{dnsCopyMessage}</p>{/if}
					</div>
				{/if}
				{#if host?.lastError}<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{host.lastError}</div>{/if}
				{#if host?.updaterLastError}<div class="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><strong>Updater connection:</strong> {host.updaterLastError} <Button variant="ghost" size="sm" onclick={()=>hostAct('refresh')} disabled={busy!==''||polling}>Retry connection</Button></div>{/if}
				{#if host?.state==='not_deployed' && provisioningMissing.length && !provisioningMissing.includes('Vercel connection')}
					<div class="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><strong>Engine deployment prerequisites:</strong> {provisioningMissing.join(', ')}</div>
				{/if}
				{#if showVercelConnection}
					<div class="rounded-lg border border-primary/30 bg-primary/5 p-4">
						<div class="flex items-start justify-between gap-3">
							<div><p class="font-medium">Connect Vercel for this Engine Host</p><p class="mt-1 text-sm text-muted-foreground">This Vercel connection is only used to create and manage this installation's standalone Shared Engine Host. Base itself does not need your Vercel account connected.</p></div>
							<Button variant="ghost" size="icon" onclick={()=>showVercelConnection=false} aria-label="Close"><X class="size-4"/></Button>
						</div>
						<form class="mt-4 space-y-3" onsubmit={connectVercelAndDeploy}>
							<div class="space-y-1.5"><label for="engine-vercel-token" class="text-sm font-medium">Vercel API token</label><Input id="engine-vercel-token" type="password" bind:value={vercelToken} autocomplete="off" placeholder="Paste Vercel token"/></div>
							<div class="space-y-1.5"><label for="engine-vercel-team" class="text-sm font-medium">Vercel Team ID or slug <span class="text-muted-foreground">(optional)</span></label><Input id="engine-vercel-team" bind:value={vercelTeamId} autocomplete="off" placeholder="Leave blank for personal account"/></div>
							<div class="flex justify-end"><Button type="submit" disabled={connectingVercel||!vercelToken.trim()}>{#if connectingVercel}<LoaderCircle class="size-4 animate-spin"/>{/if}Connect &amp; Deploy Engine</Button></div>
						</form>
					</div>
				{/if}
				<div class="flex flex-wrap gap-2">
					{#if host?.state==='not_deployed'}
						{#if provisioningAvailable}
							<Button onclick={()=>hostAct('provision')} disabled={busy!==''}><Server class="size-4"/>Inner Deploy · Shared Engine</Button>
						{:else if provisioningMissing.includes('Vercel connection')}
							<Button onclick={()=>showVercelConnection=true} disabled={busy!==''}><Server class="size-4"/>Connect Vercel &amp; Inner Deploy</Button>
						{:else}
							<Button disabled><Server class="size-4"/>Inner deployment prerequisites missing</Button>
						{/if}
						<p class="text-sm text-muted-foreground">Deploy and link the shared Inner environment first. Licensed plugins are installed into it afterwards and never create their own host.</p>
					{/if}
					{#if hostAdvancing()}<Button disabled><LoaderCircle class="size-4 animate-spin"/>Deploying &amp; linking</Button>{/if}
					{#if host?.state==='error'&&provisioningAvailable}<Button onclick={()=>hostAct('provision',{releaseId:host?.releaseId||undefined,releaseChannel:host?.releaseChannel||undefined,forceRedeploy:true})} disabled={busy!==''}>Retry Engine</Button>{/if}
					{#if host?.hostUrl&&!hostReady()&&!hostAdvancing()&&host?.state!=='error'}<Button onclick={()=>hostAct('link')} disabled={busy!==''}><PlugZap class="size-4"/>Link Engine</Button>{/if}
					{#if host?.hostUrl}<Button variant="outline" onclick={()=>hostAct('refresh')} disabled={busy!==''||polling}><RefreshCw class="size-4"/>Refresh status</Button>{/if}
					{#if hostReady()&&host?.hostUrl}<Button variant="outline" onclick={syncEngineUpdater} disabled={busy!==''||polling}><PlugZap class="size-4"/>{busy==='host:register'?'Syncing…':host?.updaterConnected?'Sync updater':'Register updater'}</Button>{/if}
					{#if hostReady()&&host?.hostUrl}<Button variant="outline" onclick={checkEngineUpdate} disabled={busy!==''||polling}><RefreshCw class="size-4"/>{busy==='host:plan'?'Checking…':'Check for update'}</Button>{/if}
					{#if hostReady()&&host?.hostUrl}<a href={host.hostUrl} target="_blank" rel="noreferrer" class="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent"><ExternalLink class="size-4"/>Open Engine</a>{/if}
					{#if host?.projectId}
						<Button variant="outline" class="text-destructive" onclick={uninstallEngine} disabled={busy!==''||polling||hostAdvancing()}>
							<Trash2 class="size-4"/>{busy==='host:uninstall'?'Removing Engine…':'Uninstall Shared Engine'}
						</Button>
					{/if}
				</div>
				{#if enginePlan}
					<div class="rounded-lg border p-4 text-sm">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div>
								<p class="font-medium">Shared Engine update</p>
								<p class="mt-1 text-muted-foreground">
									{enginePlan.plan.current?.version||host?.releaseVersion||'Not installed'} → {enginePlan.plan.target.version}
									· {enginePlan.plan.target.components.join(', ')||'shared'}
								</p>
							</div>
							<Badge variant={enginePlan.plan.blocked?'destructive':enginePlan.plan.status==='noop'?'secondary':'outline'}>{enginePlan.plan.status}</Badge>
						</div>
						{#if enginePlan.plan.reason}<p class="mt-2 text-muted-foreground">{enginePlan.plan.reason}</p>{/if}
						<p class="mt-2 text-xs text-muted-foreground">
							{enginePlan.plan.changes.added.length} added · {enginePlan.plan.changes.modified.length} changed · {enginePlan.plan.changes.removed.length} removed · {enginePlan.plan.target.fileCount} target files
						</p>
						<div class="mt-3 flex flex-wrap gap-2">
							{#if !enginePlan.plan.blocked&&enginePlan.plan.status!=='noop'}<Button onclick={applyEngineUpdate} disabled={busy!==''}>Apply Engine update</Button>{/if}
							<Button variant="ghost" onclick={()=>enginePlan=null} disabled={busy!==''}>Dismiss</Button>
						</div>
					</div>
				{/if}
			</CardContent>
		</Card>

		<div class="grid gap-4 md:grid-cols-2">
			{#each addons as addon (addon.id)}
				<Card>
					<CardHeader>
						<div class="flex items-start justify-between gap-3">
							<div><CardTitle>{addon.name}</CardTitle><CardDescription>{addon.description}</CardDescription></div>
							<Badge variant={tone(addon)}>{availability(addon)}</Badge>
						</div>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="grid grid-cols-1 gap-2 text-sm min-[420px]:grid-cols-3">
							<div class="rounded-lg border p-3"><span class="text-xs text-muted-foreground">Licence</span><p class="mt-1 font-medium">{addon.licenseAllowed===false?'Not owned':addon.licensed?'Ready':'Activation required'}</p></div>
							<div class="rounded-lg border p-3"><span class="text-xs text-muted-foreground">Panel</span><p class="mt-1 font-medium">{addon.installed?'Installed':'Not installed'}</p></div>
							<div class="rounded-lg border p-3"><span class="text-xs text-muted-foreground">Engine</span><p class="mt-1 font-medium">{recordAttached(addon)?(addon.licensed?(addon.needsSetup?'Setup required':'Linked'):'Locked'):'Not linked'}</p></div>
						</div>

						<div class="flex flex-wrap gap-2">
							{#if !addon.available}
								<Button disabled>Unavailable</Button>
							{:else if addon.licenseAllowed===false}
								<Button disabled>Licence required</Button>
							{:else}
								{#if !addon.installed}<Button onclick={()=>addonAct(addon.id,'install')} disabled={busy!==''||addon.installStatus==='installing'||!hostReady()}>{#if addon.installStatus==='installing'}<LoaderCircle class="size-4 animate-spin"/>Installing…{:else}{hostReady()?'Install':'Deploy Shared Engine first'}{/if}</Button>{/if}
								{#if addon.installed&&!recordAttached(addon)}<Button onclick={()=>addonAct(addon.id,'link')} disabled={busy!==''||!hostReady()}><PlugZap class="size-4"/>Link to Engine</Button>{/if}
								{#if recordAttached(addon)&&addon.licensed&&engineUrl(addon)}<a href={engineUrl(addon)} target="_blank" rel="noreferrer" class="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"><ExternalLink class="size-4"/>Open in Engine</a>{/if}
							{/if}
							{#if recordAttached(addon)}<Button variant="outline" onclick={()=>addonAct(addon.id,'unlink')} disabled={busy!==''}><Unplug class="size-4"/>Unlink</Button>{/if}
							{#if addon.installed}<Button variant="ghost" class="text-destructive" onclick={()=>remove(addon.id)} disabled={busy!==''}><Trash2 class="size-4"/>Uninstall</Button>{/if}
						</div>

						{#if addon.licenseAllowed===false}<p class="text-xs text-muted-foreground">This add-on is visible in the library but cannot be installed or linked because the licence does not include it.</p>{/if}
						{#if addon.installed&&!recordAttached(addon)&&!hostReady()}<p class="text-xs text-muted-foreground">Deploy and link the shared Engine first, then link this add-on to it.</p>{/if}
					</CardContent>
				</Card>
			{/each}
		</div>
	{/if}
</div>