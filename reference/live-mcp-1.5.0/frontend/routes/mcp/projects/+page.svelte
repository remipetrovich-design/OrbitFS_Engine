<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { page } from '$app/state';
	import PathPicker from '$lib/components/path-picker.svelte';
	import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '$lib/components/ui';
	import { Folder, LoaderCircle, Plus, Trash2, Pencil, X, Save } from '@lucide/svelte';

	type Workspace = { id: string; name: string; permission: string; management_permissions?: Record<string, boolean> };
	type ProjectItem = { type: 'file' | 'folder'; path: string; item_type?: 'file' | 'folder'; item_path?: string };
	type Project = { id: string; name: string; instructions: string; ai_behaviour: string; items?: ProjectItem[] };
	type Bundle = { id: string; name: string; enabled: boolean };
	type BundleAssignment = { bundleId: string; name?: string; required: boolean };

	let workspaces = $state<Workspace[]>([]);
	let workspaceId = $state('');
	let projects = $state<Project[]>([]);
	let bundles = $state<Bundle[]>([]);
	let bundleAssignments = $state<BundleAssignment[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let editingId = $state<string | null>(null);
	let itemPicker = $state('');
	let itemKind = $state<'file' | 'folder'>('file');
	let form = $state({ name: '', instructions: '', aiBehaviour: '', items: [] as ProjectItem[] });

	function resetForm() { editingId = null; bundleAssignments = []; form = { name: '', instructions: '', aiBehaviour: '', items: [] }; }

	async function loadProjects() {
		if (!workspaceId) return;
		loading = true; error = '';
		try {
			const [projectData, bundleData] = await Promise.all([
				api.get<{ projects: Project[] }>(`/mcp/workspaces/${workspaceId}/projects`),
				api.get<{ bundles: Bundle[] }>(`/mcp/workspaces/${workspaceId}/context-bundles`)
			]);
			projects = projectData.projects; bundles = bundleData.bundles.filter((bundle) => bundle.enabled);
		}
		catch (err) { error = err instanceof ApiError ? err.message : 'Failed to load projects'; }
		finally { loading = false; }
	}
	async function load() {
		const data = await api.get<{ workspaces: Workspace[]; canManageGlobal: boolean }>('/workspaces');
		workspaces = data.workspaces.filter((workspace) =>
			workspace.permission === 'owner' || !!workspace.management_permissions?.manage_mcp_projects
		);
		const requestedWorkspace = page.url.searchParams.get('workspaceId') || '';
		workspaceId = workspaces.some((workspace) => workspace.id === requestedWorkspace) ? requestedWorkspace : (workspaces[0]?.id || '');
		const requestedPath = (page.url.searchParams.get('addPath') || '').replace(/^\/+|\/+$/g, '');
		itemKind = page.url.searchParams.get('kind') === 'folder' ? 'folder' : 'file';
		if (requestedPath) itemPicker = requestedPath;
		await loadProjects();
	}

	async function edit(project: Project) {
		editingId = project.id;
		form = { name: project.name, instructions: project.instructions || '', aiBehaviour: project.ai_behaviour || '', items: (project.items || []).map((item) => ({ type: item.item_type || item.type, path: item.item_path || item.path })) };
		itemPicker = '';
		try { bundleAssignments = (await api.get<{ assignments: BundleAssignment[] }>(`/mcp/workspaces/${workspaceId}/projects/${project.id}/context-bundles`)).assignments; }
		catch (err) { error = err instanceof ApiError ? err.message : 'Failed to load project bundles'; }
	}

	function toggleBundle(bundle: Bundle) {
		const exists = bundleAssignments.some((item) => item.bundleId === bundle.id);
		bundleAssignments = exists ? bundleAssignments.filter((item) => item.bundleId !== bundle.id) : [...bundleAssignments, { bundleId: bundle.id, name: bundle.name, required: true }];
	}
	function addProjectItem() {
		const clean = itemPicker.trim().replace(/^\/+|\/+$/g, '');
		if (!clean || form.items.some((item) => item.path === clean)) return;
		form.items = [...form.items, { type: itemKind, path: clean }];
		itemPicker = '';
	}

	async function saveProject() {
		if (!workspaceId || !form.name.trim()) return;
		saving = true; error = '';
		try {
			let projectId = editingId;
			if (editingId) await api.put(`/mcp/workspaces/${workspaceId}/projects/${editingId}`, form);
			else projectId = (await api.post<{ project: Project }>(`/mcp/workspaces/${workspaceId}/projects`, form)).project.id;
			if (projectId) await api.put(`/mcp/workspaces/${workspaceId}/projects/${projectId}/context-bundles`, { assignments: bundleAssignments });
			resetForm();
			await loadProjects();
		} catch (err) { error = err instanceof ApiError ? err.message : 'Project save failed'; }
		finally { saving = false; }
	}
	async function remove(projectId: string) {
		if (!confirm('Delete this project?')) return;
		await api.delete(`/mcp/workspaces/${workspaceId}/projects/${projectId}`);
		if (editingId === projectId) resetForm();
		await loadProjects();
	}

	load().catch((err) => { error = err instanceof ApiError ? err.message : 'Failed to load MCP projects'; loading = false; });
</script>

<div class="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
	<div><h1 class="flex items-center gap-2 text-xl font-semibold"><Folder class="size-5" />MCP Projects</h1><p class="text-sm text-muted-foreground">Reusable AI behaviour and startup instructions for a workspace.</p></div>
	{#if error}<div class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
	{#if workspaces.length === 0}
		<Card><CardContent class="p-5 text-sm text-muted-foreground">You do not own, or have Manage MCP projects permission for, any workspace.</CardContent></Card>
	{:else}
		<Card><CardHeader><CardTitle>{editingId ? 'Edit project' : 'Create project'}</CardTitle></CardHeader><CardContent class="space-y-4">
			<label class="space-y-1 text-sm"><span>Workspace</span><select class="w-full rounded-md border bg-background p-2" bind:value={workspaceId} onchange={() => { resetForm(); loadProjects(); }}>{#each workspaces as ws}<option value={ws.id}>{ws.name}</option>{/each}</select></label>
			<label class="space-y-1 text-sm"><span>Name</span><Input placeholder="Project name" bind:value={form.name} /></label>
			<div class="grid gap-3 md:grid-cols-2">
				<label class="space-y-1 text-sm"><span>AI behaviour / custom instructions</span><textarea class="min-h-32 w-full rounded-md border bg-background p-2" bind:value={form.aiBehaviour}></textarea></label>
				<label class="space-y-1 text-sm"><span>AI startup instructions</span><textarea class="min-h-32 w-full rounded-md border bg-background p-2" bind:value={form.instructions}></textarea></label>
			</div>
			<div class="space-y-2"><p class="text-sm font-medium">Project files and folders</p><div class="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_auto]"><select class="rounded-md border bg-background p-2" bind:value={itemKind}><option value="file">File</option><option value="folder">Folder</option></select><PathPicker bind:value={itemPicker} {workspaceId} /><Button type="button" variant="outline" onclick={addProjectItem}><Plus class="size-4" />Add</Button></div>{#each form.items as item, index}<div class="flex items-center justify-between rounded-md border p-3 text-sm"><span class="min-w-0 flex-1 break-all">/{item.path}{item.type === 'folder' ? ' · folder' : ''}</span><Button type="button" variant="ghost" size="icon" onclick={() => form.items = form.items.filter((_, i) => i !== index)}><Trash2 class="size-4" /></Button></div>{/each}</div>
			<div class="space-y-2"><p class="text-sm font-medium">Context bundles loaded with this project</p><div class="grid gap-2 sm:grid-cols-2">{#each bundles as bundle}<label class="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"><span class="min-w-0 break-words">{bundle.name}</span><input type="checkbox" checked={bundleAssignments.some((item) => item.bundleId === bundle.id)} onchange={() => toggleBundle(bundle)} /></label>{/each}</div>{#if bundles.length === 0}<p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No enabled context bundles are available.</p>{/if}</div>
			<div class="flex flex-wrap gap-2">
				<Button class="w-full sm:w-auto" onclick={saveProject} disabled={saving || !form.name.trim()}>{#if saving}<LoaderCircle class="size-4 animate-spin" />{:else if editingId}<Save class="size-4" />{:else}<Plus class="size-4" />{/if}{editingId ? 'Save changes' : 'Create project'}</Button>
				{#if editingId}<Button class="w-full sm:w-auto" variant="outline" onclick={resetForm}><X class="size-4" />Cancel edit</Button>{/if}
			</div>
		</CardContent></Card>
		<Card><CardHeader><CardTitle>Workspace projects</CardTitle></CardHeader><CardContent>
			{#if loading}<div class="flex justify-center py-10"><LoaderCircle class="size-5 animate-spin" /></div>
			{:else if projects.length === 0}<p class="text-sm text-muted-foreground">No projects in this workspace.</p>
			{:else}<div class="space-y-3">
				{#each projects as project}
					<div class="rounded-md border p-3 {editingId === project.id ? 'border-primary/70 bg-primary/5' : ''}">
						<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
							<div class="min-w-0 flex-1"><strong>{project.name}</strong><p class="mt-2 text-xs font-medium uppercase text-muted-foreground">AI behaviour</p><p class="whitespace-pre-wrap text-sm">{project.ai_behaviour || 'None'}</p><p class="mt-2 text-xs font-medium uppercase text-muted-foreground">Startup instructions</p><p class="whitespace-pre-wrap text-sm">{project.instructions || 'None'}</p></div>
							<div class="flex w-full justify-end gap-1 sm:w-auto sm:shrink-0"><Button variant="ghost" size="icon" aria-label="Edit project" onclick={() => edit(project)}><Pencil class="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Delete project" onclick={() => remove(project.id)}><Trash2 class="size-4" /></Button></div>
						</div>
					</div>
				{/each}
			</div>{/if}
		</CardContent></Card>
	{/if}
</div>
