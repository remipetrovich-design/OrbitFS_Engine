<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { page } from '$app/state';
	import PathPicker from '$lib/components/path-picker.svelte';
	import { Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
	import { ListTree, LoaderCircle, Plus, Save, Trash2 } from '@lucide/svelte';

	const presetKeys = ['low','medium','high','custom1','custom2'] as const;
	const requestedAddPath = (page.url.searchParams.get('addPath') || '').replace(/^\/+|\/+$/g, '');
	const requestedAddKind: 'file' | 'folder' = page.url.searchParams.get('kind') === 'folder' ? 'folder' : 'file';
	type PresetKey = typeof presetKeys[number];
	type Workspace = { id: string; name: string; permission: string; management_permissions?: Record<string, boolean> };
	type Project = { id: string; name: string; instructions?: string; aiBehaviour?: string; items?: Item[] };
	type Profile = { id: string; name: string; type?: string; status?: string };
	type ProfileBundle = { id: string; name: string; description?: string; profileIds: string[] };
	type Item = { type: 'file' | 'folder'; path: string; recursive?: boolean; item_path?: string; item_type?: 'file' | 'folder' };
	type Preset = { projectId: string | null; items: Item[]; profileIds: string[]; profileBundleIds: string[] };
	type PresetMetadata = { preset: PresetKey; displayName: string; defaultDisplayName: string };
	type Bundle = { id: string; name: string; enabled: boolean; entryCount?: number; pathEntryCount?: number; profileEntryCount?: number; knowledgeEntryCount?: number; dependencyCount?: number };
	type BundleAssignment = { bundleId: string; name?: string; required: boolean };
	const emptyBundleAssignments = (): Record<PresetKey, BundleAssignment[]> => ({
		low: [], medium: [], high: [], custom1: [], custom2: []
	});

	let workspaces = $state<Workspace[]>([]);
	let workspaceId = $state('');
	let projects = $state<Project[]>([]);
	let defaultItems = $state<Item[]>([]);
	let profiles = $state<Profile[]>([]);
	let defaultProfileIds = $state<string[]>([]);
	let profileBundles = $state<ProfileBundle[]>([]);
	let defaultProfileBundleIds = $state<string[]>([]);
	let profilePickerOpen = $state(false);
	let profilePickerTarget = $state<'default' | 'preset'>('default');
	let profilePickerMode = $state<'bundles' | 'profiles'>('bundles');
	let profilePickerSearch = $state('');
	let pickerProfileIds = $state<string[]>([]);
	let pickerBundleIds = $state<string[]>([]);
	let bundles = $state<Bundle[]>([]);
	let presetMetadata = $state<Record<PresetKey, PresetMetadata>>(Object.fromEntries(presetKeys.map((key) => [key, { preset: key, displayName: key === 'custom1' ? 'Custom 1' : key === 'custom2' ? 'Custom 2' : key[0].toUpperCase() + key.slice(1), defaultDisplayName: key === 'custom1' ? 'Custom 1' : key === 'custom2' ? 'Custom 2' : key[0].toUpperCase() + key.slice(1) }])) as Record<PresetKey, PresetMetadata>);
	let bundleAssignments = $state<Record<PresetKey, BundleAssignment[]>>(emptyBundleAssignments());
	let presets = $state<Record<PresetKey, Preset>>({
		low: { projectId: null, items: [], profileIds: [], profileBundleIds: [] }, medium: { projectId: null, items: [], profileIds: [], profileBundleIds: [] },
		high: { projectId: null, items: [], profileIds: [], profileBundleIds: [] }, custom1: { projectId: null, items: [], profileIds: [], profileBundleIds: [] },
		custom2: { projectId: null, items: [], profileIds: [], profileBundleIds: [] }
	});
	let activePreset = $state<PresetKey>('low');
	let startupStrength = $state<PresetKey>('medium');
	let startupInstructions = $state('');
	let startupAiBehaviour = $state('');
	let startupProjectIds = $state<string[]>([]);
	let editorProjectId = $state('');
	let defaultPicker = $state('');
	let presetPicker = $state('');
	let defaultBulk = $state('');
	let presetBulk = $state('');
	let loading = $state(true);
	let workspaceLoadGeneration = 0;
	let saving = $state(false);
	let error = $state('');
	let savedMessage = $state('');
	const presetLabel = (key: PresetKey) => presetMetadata[key]?.displayName || presetMetadata[key]?.defaultDisplayName || (key === 'custom1' ? 'Custom 1' : key === 'custom2' ? 'Custom 2' : key[0].toUpperCase() + key.slice(1));
	const selectedWorkspace = () => workspaces.find((workspace) => workspace.id === workspaceId);
	const canManageStartup = () => selectedWorkspace()?.permission === 'owner' || !!selectedWorkspace()?.management_permissions?.manage_mcp_startup;
	const canManagePresetNames = () => selectedWorkspace()?.permission === 'owner' || !!selectedWorkspace()?.management_permissions?.manage_mcp_preset_names;
	const normalizeItems = (items: Item[] = []) => items.map((item) => ({
		type: item.item_type || item.type,
		path: item.item_path || item.path,
		recursive: Boolean(item.recursive || (item.item_type || item.type) === 'folder')
	}));
	async function loadPresetMetadata(projectId = editorProjectId) {
		if (!workspaceId) return;
		const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
		const data = await api.get<any>(`/mcp/workspaces/${workspaceId}/preset-metadata${suffix}`);
		presetMetadata = Object.fromEntries(presetKeys.map(key => [key, data.metadata?.[key] || presetMetadata[key]])) as Record<PresetKey, PresetMetadata>;
	}
	async function loadProjectPresetState(projectId = editorProjectId) {
		if (!workspaceId) return;
		const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
		const [presetData, metadataData, assignmentData] = await Promise.all([
			api.get<any>(`/mcp/workspaces/${workspaceId}/presets${suffix}`),
			api.get<any>(`/mcp/workspaces/${workspaceId}/preset-metadata${suffix}`),
			api.get<any>(`/mcp/workspaces/${workspaceId}/preset-bundles${suffix}`)
		]);
		presets = Object.fromEntries(presetKeys.map(key => [key, {
			projectId: presetData.presets?.[key]?.projectId || projectId || null,
			items: normalizeItems(presetData.presets?.[key]?.items || []),
			profileIds: presetData.presets?.[key]?.profileIds || [],
			profileBundleIds: presetData.presets?.[key]?.profileBundleIds || []
		}])) as Record<PresetKey, Preset>;
		presetMetadata = Object.fromEntries(presetKeys.map(key => [key, metadataData.metadata?.[key] || presetMetadata[key]])) as Record<PresetKey, PresetMetadata>;
		bundleAssignments = Object.fromEntries(presetKeys.map(key => [key, assignmentData.assignments?.[key] || []])) as Record<PresetKey, BundleAssignment[]>;
	}
	async function selectPreset(key: PresetKey) {
		activePreset = key;
		presetPicker = '';
	}
	async function setActivePresetProject(projectId = editorProjectId) {
		if (!activePreset) return;
		editorProjectId = projectId || '';
		await loadProjectPresetState(editorProjectId);
	}
	function setAllPresetProjects() {
		presets = Object.fromEntries(presetKeys.map((key) => [key, { ...presets[key], projectId: editorProjectId || null }])) as Record<PresetKey, Preset>;
	}
	async function loadWorkspace(targetWorkspaceId = workspaceId) {
		const id=String(targetWorkspaceId||'').trim(); if(!id)return; const generation=++workspaceLoadGeneration; loading=true; error='';
		try {
			const request=<T,>(label:string,promise:Promise<T>)=>Promise.race<T>([promise,new Promise<T>((_,reject)=>setTimeout(()=>reject(new Error(label+' timed out')),4000))]);
			const results=await Promise.allSettled([request('projects',api.get<any>(`/mcp/workspaces/${id}/projects`)),request('startup',api.get<any>(`/mcp/workspaces/${id}/startup`)),request('presets',api.get<any>(`/mcp/workspaces/${id}/presets`)),request('context bundles',api.get<any>(`/mcp/workspaces/${id}/context-bundles`)),request('preset bundles',api.get<any>(`/mcp/workspaces/${id}/preset-bundles`)),request('profiles',api.get<any>(`/profiles/${id}/catalog`))]);
			const get=(i:number,f:any)=>results[i].status==='fulfilled'?(results[i] as PromiseFulfilledResult<any>).value:f; const projectData=get(0,{projects:[]}),startupData=get(1,{startup:{}}),presetData=get(2,{presets:{}}),bundleData=get(3,{bundles:[]}),assignmentData=get(4,{assignments:{}}),profileData=get(5,{profiles:[],profileBundles:[]});
			if(generation!==workspaceLoadGeneration||id!==workspaceId)return; projects=projectData.projects||[]; defaultItems=normalizeItems(startupData.startup?.defaultItems||[]); profiles=profileData.profiles||[]; profileBundles=profileData.profileBundles||[]; defaultProfileIds=startupData.startup?.defaultProfileIds||[]; defaultProfileBundleIds=startupData.startup?.defaultProfileBundleIds||[]; startupStrength=(startupData.startup?.strength||'medium') as PresetKey; startupInstructions=startupData.startup?.instructions||''; startupAiBehaviour=startupData.startup?.aiBehaviour||''; startupProjectIds=startupData.startup?.projectIds||[]; bundles=(bundleData.bundles||[]).filter((bundle:Bundle)=>bundle.enabled); editorProjectId=editorProjectId&&projects.some((project:Project)=>project.id===editorProjectId)?editorProjectId:(startupProjectIds[0]||projects[0]?.id||''); await loadProjectPresetState(editorProjectId); const failed=results.map((r,i)=>r.status==='rejected'?['projects','startup','presets','context bundles','preset bundles','profiles'][i]:'').filter(Boolean); if(failed.length)error='Some startup data failed: '+failed.join(', ');
		} catch(err){ error=err instanceof ApiError?err.message:'Failed to load startup presets'; } finally { if(generation===workspaceLoadGeneration&&id===workspaceId)loading=false; }
	}
	async function load() {
		const data = await api.get<{ workspaces: Workspace[]; canManageGlobal: boolean }>('/workspaces');
		workspaces = data.workspaces.filter((workspace) =>
			workspace.permission === 'owner' || !!workspace.management_permissions?.manage_mcp_startup || !!workspace.management_permissions?.manage_mcp_preset_names
		);
		const requestedWorkspace = page.url.searchParams.get('workspaceId') || '';
		workspaceId = workspaces.some((workspace) => workspace.id === requestedWorkspace) ? requestedWorkspace : (workspaces[0]?.id || '');
		if (requestedAddPath) defaultPicker = requestedAddPath;
		await loadWorkspace();
	}
	function addDefault() {
		if (!defaultPicker || defaultItems.some((item) => item.path === defaultPicker)) return;
		defaultItems = [...defaultItems, { type: defaultPicker === requestedAddPath ? requestedAddKind : 'file', path: defaultPicker, recursive: defaultPicker === requestedAddPath && requestedAddKind === 'folder' }];
		defaultPicker = '';
	}
	function addPresetItem() {
		if (!activePreset || !presetPicker || presets[activePreset].items.some((item) => item.path === presetPicker)) return;
		presets = { ...presets, [activePreset]: { ...presets[activePreset], items: [...presets[activePreset].items, { type: presetPicker === requestedAddPath ? requestedAddKind : 'file', path: presetPicker, recursive: presetPicker === requestedAddPath && requestedAddKind === 'folder' }] } };
		presetPicker = '';
	}
	function removePresetItem(path: string) {
		if (!activePreset) return;
		presets = { ...presets, [activePreset]: { ...presets[activePreset], items: presets[activePreset].items.filter((item) => item.path !== path) } };
	}
	function addPaths(target: 'default' | 'preset', value: string) {
		const paths = value.split(/\r?\n/).map((line) => line.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
		const unique = paths.map((path) => ({ type: 'file' as const, path, recursive: true }));
		if (target === 'default') defaultItems = [...defaultItems, ...unique.filter((item) => !defaultItems.some((existing) => existing.path === item.path))];
		else if (activePreset) presets = { ...presets, [activePreset]: { ...presets[activePreset], items: [...presets[activePreset].items, ...unique.filter((item) => !presets[activePreset].items.some((existing) => existing.path === item.path))] } };
	}
	function toggleBundle(bundle: Bundle) {
		if (!activePreset) return;
		const current = bundleAssignments[activePreset];
		const exists = current.some((item) => item.bundleId === bundle.id);
		bundleAssignments = { ...bundleAssignments, [activePreset]: exists ? current.filter((item) => item.bundleId !== bundle.id) : [...current, { bundleId: bundle.id, name: bundle.name, required: true }] };
	}
	function setBundleRequired(bundleId: string, required: boolean) {
		if (!activePreset) return;
		bundleAssignments = { ...bundleAssignments, [activePreset]: bundleAssignments[activePreset].map((item) => item.bundleId === bundleId ? { ...item, required } : item) };
	}
	function openProfilePicker(target: 'default' | 'preset' = 'default') { profilePickerTarget = target; const preset = activePreset ? presets[activePreset] : null; pickerProfileIds = target === 'preset' && preset ? [...preset.profileIds] : [...defaultProfileIds]; pickerBundleIds = target === 'preset' && preset ? [...preset.profileBundleIds] : [...defaultProfileBundleIds]; profilePickerSearch = ''; profilePickerMode = profileBundles.length ? 'bundles' : 'profiles'; profilePickerOpen = true; }
	function addSelectedProfiles(event: SubmitEvent) {
		const form = event.currentTarget as HTMLFormElement;
		const data = new FormData(form);
		const profileIds = data.getAll('profileId').map((value) => String(value));
		const profileBundleIds = data.getAll('profileGroupId').map((value) => String(value));
		if (profilePickerTarget === 'preset' && activePreset) presets = { ...presets, [activePreset]: { ...presets[activePreset], profileIds, profileBundleIds } };
		else { defaultProfileIds = profileIds; defaultProfileBundleIds = profileBundleIds; }
		profilePickerOpen = false;
	}
	function pickerProfiles() { const q = profilePickerSearch.trim().toLowerCase(); return profiles.filter((profile) => !q || `${profile.name} ${profile.type || ''}`.toLowerCase().includes(q)); }
	function pickerBundles() { const q = profilePickerSearch.trim().toLowerCase(); return profileBundles.filter((bundle) => !q || `${bundle.name} ${bundle.description || ''}`.toLowerCase().includes(q)); }

	async function saveAll() {
		if (!workspaceId) return;
		saving = true; error = ''; savedMessage = '';
		const tasks: Array<[string, Promise<unknown>]> = [];
		if (canManageStartup()) {
			tasks.push(['startup settings', api.put(`/mcp/workspaces/${workspaceId}/startup`, { strength: startupStrength, instructions: startupInstructions, aiBehaviour: startupAiBehaviour, projectIds: startupProjectIds })]);
			tasks.push(['default loading paths', api.put(`/mcp/workspaces/${workspaceId}/default-items`, { items: defaultItems })]);
			tasks.push(['default loading profiles', api.put(`/mcp/workspaces/${workspaceId}/default-profiles`, { profileIds: defaultProfileIds, profileBundleIds: defaultProfileBundleIds })]);
			tasks.push(['preset files/projects', api.put(`/mcp/workspaces/${workspaceId}/presets`, { projectId: editorProjectId || null, presets })]);
			tasks.push(['preset bundles', api.put(`/mcp/workspaces/${workspaceId}/preset-bundles`, { projectId: editorProjectId || null, assignments: bundleAssignments })]);
		}
		if (canManagePresetNames()) tasks.push(['preset names', api.put(`/mcp/workspaces/${workspaceId}/preset-metadata`, { projectId: editorProjectId || null, metadata: presetMetadata })]);
		try {
			const results = await Promise.allSettled(tasks.map(([, promise]) => promise));
			const failures = results.map((result, index) => ({ result, label: tasks[index][0] })).filter(({ result }) => result.status === 'rejected');
			await loadWorkspace();
			if (failures.length) {
				error = failures.map(({ result, label }) => `${label}: ${result.status === 'rejected' && result.reason instanceof Error ? result.reason.message : 'save failed'}`).join(' - ');
			} else savedMessage = 'Startup System saved and reloaded from storage.';
		} catch (err) { error = err instanceof ApiError ? err.message : 'Failed to verify saved startup settings'; }
		finally { saving = false; }
	}
	load().catch((err) => { error = err instanceof ApiError ? err.message : 'Failed to load workspaces'; loading = false; });
</script>
<div class="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
	<div><h1 class="flex items-center gap-2 text-xl font-semibold"><ListTree class="size-5" />OrbitFS Startup System (OSS)</h1><p class="text-sm text-muted-foreground">Configure what each ChatGPT Startup button loads, including its name, project, files, folders and context bundles.</p></div>
	{#if error}<div class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
	{#if savedMessage}<div class="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{savedMessage}</div>{/if}
	{#if workspaces.length === 0}
		<Card><CardContent class="p-5 text-sm text-muted-foreground">You do not own, or have Manage MCP startup / preset-name permission for, any workspace.</CardContent></Card>
	{:else}
		<Card><CardHeader><CardTitle>Startup editor</CardTitle></CardHeader><CardContent class="grid gap-3 md:grid-cols-2">
			<label class="space-y-1 text-sm"><span>Workspace</span><select class="w-full rounded-md border bg-background p-2" value={workspaceId} onchange={(event) => { workspaceId = event.currentTarget.value; void loadWorkspace(workspaceId); }}>{#each workspaces as ws}<option value={ws.id}>{ws.name}</option>{/each}</select></label>
			<label class="space-y-1 text-sm"><span>Project</span><select class="w-full rounded-md border bg-background p-2" value={editorProjectId} onchange={(event) => void setActivePresetProject(event.currentTarget.value)} disabled={!canManageStartup()}><option value="">No project</option>{#each projects as project}<option value={project.id}>{project.name}</option>{/each}</select></label>
		</CardContent></Card>
		{#if loading}<div class="flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm"><LoaderCircle class="size-4 animate-spin" />Loading OSS data for this workspace...</div>{/if}
			<Card><CardHeader><CardTitle>Default loading files and folders</CardTitle></CardHeader><CardContent class="space-y-3">
				<p class="text-sm text-muted-foreground">Added whenever you explicitly run a preset. Nothing here loads just from opening OrbitFS, this page, or a workspace. Folders include every readable file in nested subfolders.</p>
				<div class="flex flex-col gap-2 sm:flex-row"><div class="min-w-0 flex-1"><PathPicker bind:value={defaultPicker} {workspaceId} disabled={!canManageStartup()} /></div><Button type="button" variant="outline" onclick={addDefault} disabled={!canManageStartup()}><Plus class="size-4" />Add</Button></div>
				<label class="space-y-1 text-sm"><span>Bulk add paths</span><textarea class="min-h-24 w-full rounded-md border bg-background p-2" placeholder="One file or folder path per line" bind:value={defaultBulk} disabled={!canManageStartup()}></textarea></label>
				<Button type="button" variant="outline" onclick={() => { addPaths('default', defaultBulk); defaultBulk = ''; }} disabled={!defaultBulk.trim() || !canManageStartup()}><Plus class="size-4" />Add bulk paths</Button>
				{#if defaultItems.length === 0}<p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No default loading files or folders selected.</p>{:else}<div class="space-y-2">{#each defaultItems as item}<div class="flex items-center justify-between rounded-md border p-3 text-sm"><span class="min-w-0 flex-1 break-all pr-2">/{item.path}{item.type === 'folder' ? ' - recursive folder' : ''}</span><Button type="button" variant="ghost" size="icon" onclick={() => (defaultItems = defaultItems.filter((entry) => entry.path !== item.path))} disabled={!canManageStartup()}><Trash2 class="size-4" /></Button></div>{/each}</div>{/if}
				<div class="space-y-2 border-t pt-3"><p class="text-sm font-medium">Default loading profiles</p><p class="text-xs text-muted-foreground">Tick any groups or individual profiles. Groups stay linked and resolve their current members whenever a preset is run.</p>{#if profileBundles.length === 0 && profiles.length === 0}<p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No accessible groups or profiles are available.</p>{:else}<div class="grid gap-2 sm:grid-cols-2">{#each profileBundles as group}<label class="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"><span class="min-w-0"><span class="block break-words font-medium">{group.name}</span><span class="block text-xs text-muted-foreground">Group · {group.profileIds.length} profiles</span></span><input type="checkbox" checked={defaultProfileBundleIds.includes(group.id)} onchange={() => defaultProfileBundleIds = defaultProfileBundleIds.includes(group.id) ? defaultProfileBundleIds.filter((id) => id !== group.id) : [...defaultProfileBundleIds, group.id]} disabled={!canManageStartup()} /></label>{/each}{#each profiles as profile}<label class="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"><span class="min-w-0 break-words">{profile.name}{profile.type ? ` · ${profile.type}` : ''}</span><input type="checkbox" checked={defaultProfileIds.includes(profile.id)} onchange={() => defaultProfileIds = defaultProfileIds.includes(profile.id) ? defaultProfileIds.filter((id) => id !== profile.id) : [...defaultProfileIds, profile.id]} disabled={!canManageStartup()} /></label>{/each}</div>{/if}</div>
			</CardContent></Card>
			<Card><CardHeader><CardTitle>Startup presets</CardTitle></CardHeader><CardContent class="space-y-4">
			{#if canManagePresetNames() && !canManageStartup()}<div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">You can rename preset buttons for this workspace, but cannot change startup files, projects, or bundles.</div>{/if}
				<div class="grid grid-cols-2 gap-2 sm:grid-cols-5">{#each presetKeys as key}<Button variant={activePreset === key ? 'default' : 'outline'} onclick={() => void selectPreset(key)}>{presetLabel(key)}</Button>{/each}</div>
				{#if activePreset}
		<label class="space-y-1 text-sm"><span>Preset button name</span><input class="w-full rounded-md border bg-background p-2" maxlength="40" bind:value={presetMetadata[activePreset].displayName} disabled={!canManagePresetNames()} placeholder={presetMetadata[activePreset].defaultDisplayName} /></label>
				<Button type="button" variant="outline" onclick={setAllPresetProjects} disabled={!canManageStartup()}>Use this project for all presets</Button>
				<div class="space-y-2"><p class="text-sm font-medium">Files and folders for this preset</p><div class="flex flex-col gap-2 sm:flex-row"><div class="min-w-0 flex-1"><PathPicker bind:value={presetPicker} {workspaceId} disabled={!canManageStartup()} /></div><Button type="button" variant="outline" onclick={addPresetItem} disabled={!canManageStartup()}><Plus class="size-4" />Add</Button></div><label class="space-y-1 text-sm"><span>Bulk add preset paths</span><textarea class="min-h-24 w-full rounded-md border bg-background p-2" placeholder="One file or folder path per line" bind:value={presetBulk} disabled={!canManageStartup()}></textarea></label><Button type="button" variant="outline" onclick={() => { addPaths('preset', presetBulk); presetBulk = ''; }} disabled={!presetBulk.trim() || !canManageStartup()}><Plus class="size-4" />Add bulk paths</Button></div>
				{#if presets[activePreset].items.length === 0}<p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No files or folders selected for this preset.</p>{:else}<div class="space-y-2">{#each presets[activePreset].items as item}<div class="flex items-center justify-between rounded-md border p-3 text-sm"><span class="min-w-0 flex-1 break-all pr-2">/{item.path}{item.type === 'folder' ? ' - recursive folder' : ''}</span><Button type="button" variant="ghost" size="icon" onclick={() => removePresetItem(item.path)} disabled={!canManageStartup()}><Trash2 class="size-4" /></Button></div>{/each}</div>{/if}
				<div class="space-y-2 border-t pt-3"><p class="text-sm font-medium">Profiles for this preset</p><p class="text-xs text-muted-foreground">Tick any groups or individual profiles for this preset. Groups stay linked and resolve their current members when the preset runs.</p>{#if profileBundles.length === 0 && profiles.length === 0}<p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No accessible groups or profiles are available.</p>{:else}<div class="grid gap-2 sm:grid-cols-2">{#each profileBundles as group}<label class="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"><span class="min-w-0"><span class="block break-words font-medium">{group.name}</span><span class="block text-xs text-muted-foreground">Group · {group.profileIds.length} profiles</span></span><input type="checkbox" checked={presets[activePreset].profileBundleIds.includes(group.id)} onchange={() => presets = { ...presets, [activePreset]: { ...presets[activePreset], profileBundleIds: presets[activePreset].profileBundleIds.includes(group.id) ? presets[activePreset].profileBundleIds.filter((id) => id !== group.id) : [...presets[activePreset].profileBundleIds, group.id] } }} disabled={!canManageStartup()} /></label>{/each}{#each profiles as profile}<label class="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"><span class="min-w-0 break-words">{profile.name}{profile.type ? ` · ${profile.type}` : ''}</span><input type="checkbox" checked={presets[activePreset].profileIds.includes(profile.id)} onchange={() => presets = { ...presets, [activePreset]: { ...presets[activePreset], profileIds: presets[activePreset].profileIds.includes(profile.id) ? presets[activePreset].profileIds.filter((id) => id !== profile.id) : [...presets[activePreset].profileIds, profile.id] } }} disabled={!canManageStartup()} /></label>{/each}</div>{/if}</div>
				<div class="space-y-2"><p class="text-sm font-medium">Context bundles for this preset</p><p class="text-xs text-muted-foreground">Bundles can contain canonical Base Library items, profiles, files/folders and dependencies. Library entries resolve by Knowledge Item ID every time OSS runs, so renamed/moved Library sources stay linked.</p><div class="grid gap-2 sm:grid-cols-2">{#each bundles as bundle}{@const assigned=bundleAssignments[activePreset].find((item)=>item.bundleId===bundle.id)}<div class="rounded-md border p-3 text-sm"><label class="flex items-start justify-between gap-3"><span class="min-w-0"><span class="block break-words font-medium">{bundle.name}</span><span class="block text-xs text-muted-foreground">{bundle.knowledgeEntryCount || 0} Library · {bundle.profileEntryCount || 0} profiles · {bundle.pathEntryCount || 0} paths{bundle.dependencyCount ? ` · ${bundle.dependencyCount} dependencies` : ''}</span></span><input type="checkbox" checked={!!assigned} onchange={() => toggleBundle(bundle)} disabled={!canManageStartup()} /></label>{#if assigned}<label class="mt-2 flex items-center gap-2 border-t pt-2 text-xs"><input type="checkbox" checked={assigned.required !== false} onchange={(event)=>setBundleRequired(bundle.id,event.currentTarget.checked)} disabled={!canManageStartup()} />Required at startup <span class="text-muted-foreground">(off = load if available)</span></label>{/if}</div>{/each}</div>{#if bundles.length === 0}<p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No enabled context bundles are available.</p>{/if}</div>
				{/if}
			</CardContent></Card>
			<Button class="w-full sm:w-auto" onclick={saveAll} disabled={saving || loading}>{#if saving}<LoaderCircle class="size-4 animate-spin" />{:else}<Save class="size-4" />{/if}Save Startup System</Button>
	{/if}
</div>
