<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui';
	import { Cloud, GitBranch, RefreshCw, LoaderCircle, Server, ShieldCheck } from '@lucide/svelte';

	type DeploymentStatus = {
		platform:string; environment:string; branch:string; commit:string|null;
		commitMessage:string|null; deploymentUrl:string; productionUrl:string;
		provider:string; managed:boolean; checkedAt:string;
		version:string|null; releaseChannel:string; activeRelease:Record<string,any>|null;
		projectId:string|null; installationRoute:string; installationRegistered:boolean;
		baseUpdate:{ mode:string; ready:boolean; projectId:string|null; blocker:string|null };
	};
	type BaseReleaseCheck = {
		ok:boolean; authority:string; product:string; channel:string; type:string;
		currentVersion:string|null; publishedVersion:string|null; updateAvailable:boolean|null;
		latest:Record<string,any>|null;
	};
	type Checkpoint = {
		id:string; createdAt:string; reason:string; targetVersion:string|null; fingerprint:string;
		activeRelease:Record<string,any>|null;
		panel:{ branch:string; commit:string|null; deploymentUrl:string|null; productionUrl:string|null };
		engineHost:Record<string,any>;
		addons:Array<Record<string,any>>;
	};

	let status = $state<DeploymentStatus|null>(null);
	let baseRelease = $state<BaseReleaseCheck|null>(null);
	let targetedUpdate = $state<BaseReleaseCheck|null>(null);
	let checkpoints = $state<Checkpoint[]>([]);
	let loading = $state(true);
	let creatingCheckpoint = $state(false);
	let error = $state('');
	let success = $state('');

	async function load() {
		loading = true; error = ''; success = '';
		try {
			const [deployment, releaseResult, updateResult, checkpointResult] = await Promise.all([
				api.get<DeploymentStatus>('/system/deployment-status'),
				api.get<BaseReleaseCheck>('/release/check?type=base'),
				api.get<BaseReleaseCheck>('/release/check?type=update').catch(() => null),
				api.get<{ checkpoints: Checkpoint[] }>('/system/update-checkpoints')
			]);
			status = deployment;
			baseRelease = releaseResult;
			targetedUpdate = updateResult;
			checkpoints = checkpointResult.checkpoints || [];
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Failed to load update status';
		} finally { loading = false; }
	}

	const includesBasePatch = () => {
		const current = targetedUpdate?.latest;
		const components = Array.isArray(current?.components) ? current.components : Array.isArray(current?.manifest?.components) ? current.manifest.components : [];
		return components.some((component:unknown) => String(component||'').trim().toLowerCase()==='base');
	};
	const entitledToBasePatch = () => {
		const plan=targetedUpdate?.latest?.componentPlan;
		return !plan || !Array.isArray(plan.executionComponents) || plan.executionComponents.includes('base');
	};

	async function createCheckpoint() {
		creatingCheckpoint = true; error = ''; success = '';
		try {
			const result = await api.post<{ ok:boolean; checkpoint:Checkpoint }>('/system/update-checkpoints', { reason:'manual-pre-update' });
			checkpoints = [result.checkpoint, ...checkpoints.filter((item) => item.id !== result.checkpoint.id)].slice(0, 20);
			success = 'Checkpoint saved. The deployment system can use this state anchor when performing a rollback.';
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Failed to create update checkpoint';
		} finally { creatingCheckpoint = false; }
	}

	load();
</script>

<div class="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold"><Cloud class="size-5" />Updates</h1>
			<p class="text-sm text-muted-foreground">OrbitFS releases redeploy the existing Vercel projects while Supabase keeps installation state and customer data.</p>
		</div>
		<Button variant="outline" size="sm" onclick={load} disabled={loading || creatingCheckpoint}>
			{#if loading}<LoaderCircle class="size-4 animate-spin" />{:else}<RefreshCw class="size-4" />Refresh{/if}
		</Button>
	</div>

	{#if error}<div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>{/if}
	{#if success}<div class="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{success}</div>{/if}

	{#if loading}
		<div class="flex items-center justify-center gap-2 py-20 text-muted-foreground"><LoaderCircle class="size-5 animate-spin" />Loading deployment&hellip;</div>
	{:else if status}
		<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
			<Card><CardHeader><CardTitle class="flex items-center gap-2"><Server class="size-4" />Installed Base</CardTitle><CardDescription>Version running on this installation</CardDescription></CardHeader>
				<CardContent><Badge variant="secondary">{status.version || 'Unknown'}</Badge><p class="mt-2 text-xs text-muted-foreground">{status.environment} · {status.releaseChannel}</p></CardContent></Card>
			<Card><CardHeader><CardTitle class="flex items-center gap-2"><Cloud class="size-4" />Published Base</CardTitle><CardDescription>Authoritative License Manager release</CardDescription></CardHeader>
				<CardContent><Badge variant={baseRelease?.updateAvailable ? 'outline' : 'success'}>{baseRelease?.publishedVersion || 'Unavailable'}</Badge><p class="mt-2 text-xs text-muted-foreground">{baseRelease?.updateAvailable===true ? 'New published Base release available' : baseRelease?.updateAvailable===false ? 'Installed Base matches published release' : 'Unable to determine Base version difference'}</p></CardContent></Card>
			<Card><CardHeader><CardTitle class="flex items-center gap-2"><GitBranch class="size-4" />Registered project</CardTitle><CardDescription>Base updates redeploy this exact Vercel project</CardDescription></CardHeader>
				<CardContent><Badge variant={status.baseUpdate.ready ? 'success' : 'outline'}>{status.baseUpdate.ready ? 'Ready' : 'Blocked'}</Badge><p class="mt-2 font-mono text-xs text-muted-foreground break-all">{status.projectId || 'Project ID not registered'}</p></CardContent></Card>
			<Card><CardHeader><CardTitle class="flex items-center gap-2"><ShieldCheck class="size-4" />Targeted Base Update</CardTitle><CardDescription>Latest published UPDATE_RELEASE package</CardDescription></CardHeader>
				<CardContent>
					<Badge variant={includesBasePatch()&&entitledToBasePatch()?'outline':'secondary'}>{includesBasePatch()?targetedUpdate?.publishedVersion||'Published':'Not included'}</Badge>
					<p class="mt-2 text-xs text-muted-foreground">{includesBasePatch()?(entitledToBasePatch()?'Latest published Update declares a Base patch. The standalone Updater must verify its manifest, compatibility, checkpoint and release authority before applying.':'Published Update declares Base, but the licence execution plan does not authorize it for this installation.'):'Latest published Update does not include a Base patch.'}</p>
				</CardContent></Card>
		</div>

		<Card>
			<CardHeader><CardTitle>Current deployment</CardTitle><CardDescription>Production and build metadata for this Vercel release.</CardDescription></CardHeader>
			<CardContent class="space-y-3 text-sm">
				<div><span class="text-muted-foreground">Production URL</span><div class="font-mono text-xs break-all">{status.productionUrl}</div></div>
				<div><span class="text-muted-foreground">Deployment URL</span><div class="font-mono text-xs break-all">{status.deploymentUrl}</div></div>
				<div><span class="text-muted-foreground">Base version</span><div class="font-mono text-xs">{status.version || 'Unknown'}</div></div>
				<div><span class="text-muted-foreground">Published Base</span><div class="font-mono text-xs">{baseRelease?.publishedVersion || 'Unavailable'}</div></div>
				<div><span class="text-muted-foreground">Registered Vercel project</span><div class="font-mono text-xs break-all">{status.projectId || 'Not registered'}</div></div>
				{#if status.commitMessage}<div><span class="text-muted-foreground">Commit</span><div>{status.commitMessage}</div></div>{/if}
				<div class="text-xs text-muted-foreground">Checked {new Date(status.checkedAt).toLocaleString()}</div>
			</CardContent>
		</Card>

		<Card>
			<CardHeader class="gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<CardTitle>Update checkpoints</CardTitle>
					<CardDescription>State anchors for the customer deployment system. Customer files are not duplicated.</CardDescription>
				</div>
				<Button size="sm" onclick={createCheckpoint} disabled={creatingCheckpoint}>
					{#if creatingCheckpoint}<LoaderCircle class="size-4 animate-spin" />{/if}
					Save checkpoint
				</Button>
			</CardHeader>
			<CardContent class="space-y-3">
				<p class="text-sm text-muted-foreground">Before an Engine/add-on UPDATE_RELEASE is applied, OrbitFS saves the current Panel deployment, Engine Host link/release state, installed add-on state, safe global settings and active release metadata. Base releases use the dedicated Base Deployer and redeploy the registered Base Vercel project.</p>
				{#if checkpoints.length === 0}
					<div class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No checkpoints yet.</div>
				{:else}
					<div class="space-y-2">
						{#each checkpoints.slice(0, 5) as checkpoint (checkpoint.id)}
							<div class="rounded-md border p-3 text-sm">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<div class="font-medium">{new Date(checkpoint.createdAt).toLocaleString()}</div>
									<Badge variant="secondary">{checkpoint.reason}</Badge>
								</div>
								<div class="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
									<div>Panel: <span class="font-mono">{checkpoint.panel.commit?.slice(0,12) || checkpoint.panel.branch}</span></div>
									<div>Active release: <span class="font-mono">{checkpoint.activeRelease?.version || 'not recorded yet'}</span></div>
									<div>Engine Host: <span class="font-mono">{checkpoint.engineHost?.state || 'not configured'}</span></div>
									<div>Fingerprint: <span class="font-mono">{checkpoint.fingerprint.slice(0,12)}</span></div>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</CardContent>
		</Card>

		<Card>
			<CardHeader><CardTitle>Release branches</CardTitle><CardDescription>Simple two-channel release model.</CardDescription></CardHeader>
			<CardContent class="space-y-3 text-sm text-muted-foreground">
				<div><b class="text-foreground">base-release</b> — controlled source for initial Base installs and later major Base updates. Published Base releases are delivered on <b class="text-foreground">{status.releaseChannel}</b> and must redeploy the registered Base Vercel project.</div>
				<div><b class="text-foreground">UPDATE_RELEASE</b> — immutable targeted Update packages may include Base, APEX, MCP and Studio when explicitly declared and approved. The standalone OrbitFS Updater applies authorized Base patch payloads; the Base-owned inner deployer remains Engine/add-on-only and must not silently mutate Base files.</div>
			</CardContent>
		</Card>
	{/if}
</div>