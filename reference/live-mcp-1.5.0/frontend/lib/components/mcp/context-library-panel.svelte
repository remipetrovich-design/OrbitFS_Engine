<script lang="ts">
  import { api, ApiError } from '$lib/api';
  import { page } from '$app/state';
  import PathPicker from '$lib/components/path-picker.svelte';
  import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '$lib/components/ui';
  import { BookOpen, LoaderCircle, Pencil, Plus, Save, Trash2, X } from '@lucide/svelte';

  type Workspace = { id: string; name: string; permission: string; management_permissions?: Record<string, boolean> };
  type Entry = { type: 'file' | 'folder' | 'knowledge'; path: string; recursive: boolean; required: boolean; priority: number; attachmentType?: 'path' | 'profile' | 'knowledge'; profileId?: string | null; profileName?: string | null; knowledgeItemId?: string | null; knowledgeItemName?: string | null; loadMode?: string | null };
  type Dependency = { bundleId: string; name?: string; required: boolean };
  type Profile = { id: string; name: string; sourcePath?: string | null; fields?: Record<string, unknown>; restricted?: boolean };
  type KnowledgeItem = { id:string; name:string; kind:string; roles?:string[]; lifecycleState?:string; loadMode?:string; status?:string; source?:any };
  type Bundle = { id: string; name: string; description: string; enabled: boolean; version: number; entryCount?: number; pathEntryCount?: number; profileEntryCount?: number; knowledgeEntryCount?: number; dependencyCount?: number; entries?: Entry[]; dependencies?: Dependency[] };
  let { workspaceIdOverride = '', hideWorkspacePicker = false } = $props<{ workspaceIdOverride?: string; hideWorkspacePicker?: boolean }>();

  let workspaces = $state<Workspace[]>([]), workspaceId = $state(''), bundles = $state<Bundle[]>([]), profiles = $state<Profile[]>([]), knowledgeItems = $state<KnowledgeItem[]>([]);
  let loading = $state(true), saving = $state(false), error = $state(''), savedMessage = $state(''), editingId = $state<string | null>(null);
  let picker = $state(''), pickerType = $state<'file' | 'folder'>('file'), selectedProfileId = $state(''), selectedKnowledgeId = $state('');
  let form = $state({ name: '', description: '', enabled: true, entries: [] as Entry[], dependencies: [] as Dependency[] });

  function cleanPath(value: unknown) { return String(value || '').trim().replace(/^\/+|\/+$/g, ''); }
  function hydrateEntry(entry: Entry): Entry {
    if (entry.attachmentType === 'knowledge' || entry.attachmentType === 'profile') return { ...entry };
    const profile = profiles.find((item) => cleanPath(item.sourcePath) === cleanPath(entry.path));
    return profile
      ? { ...entry, attachmentType: 'profile', profileId: profile.id, profileName: profile.name }
      : { ...entry, attachmentType: 'path', profileId: null, profileName: null };
  }
  function applyBundle(bundle: Bundle) {
    editingId = bundle.id;
    form = {
      name: bundle.name,
      description: bundle.description || '',
      enabled: bundle.enabled,
      entries: (bundle.entries || []).map(hydrateEntry),
      dependencies: (bundle.dependencies || []).map((dep) => ({ bundleId: dep.bundleId, name: dep.name, required: dep.required }))
    };
  }
  function reset() {
    editingId = null; picker = ''; selectedProfileId = ''; selectedKnowledgeId = ''; savedMessage = '';
    form = { name: '', description: '', enabled: true, entries: [], dependencies: [] };
  }
  async function loadBundles() {
    if (!workspaceId) return;
    loading = true; error = '';
    try {
      const [bundleData, profileData, libraryData] = await Promise.all([
        api.get<{ bundles: Bundle[] }>(`/mcp/workspaces/${workspaceId}/context-bundles`),
        api.get<{ profiles?: Profile[] }>(`/profiles/${workspaceId}/catalog`),
        api.get<{ items?: KnowledgeItem[] }>(`/library/workspaces/${workspaceId}`).catch(() => ({ items: [] }))
      ]);
      bundles = bundleData.bundles;
      profiles = profileData.profiles || [];
      knowledgeItems = (libraryData.items || []).filter((item) => item.status !== 'archived');
    }
    catch (err) { error = err instanceof ApiError ? err.message : 'Failed to load context bundles'; }
    finally { loading = false; }
  }
  async function load() {
    const data = await api.get<{ workspaces: Workspace[] }>('/workspaces');
    workspaces = data.workspaces.filter((ws) => ws.permission === 'owner' || !!ws.management_permissions?.manage_mcp_startup);
    const requestedWorkspace = page.url.searchParams.get('workspaceId') || '';
    const preferredWorkspace = workspaceIdOverride || requestedWorkspace;
    workspaceId = workspaces.some((ws) => ws.id === preferredWorkspace) ? preferredWorkspace : (workspaces[0]?.id || '');
    const requestedPath = (page.url.searchParams.get('addPath') || '').replace(/^\/+|\/+$/g, '');
    const requestedKind = page.url.searchParams.get('kind') === 'folder' ? 'folder' : 'file';
    if (requestedPath) { picker = requestedPath; pickerType = requestedKind; }
    await loadBundles();
  }
  async function editBundle(bundle: Bundle) {
    error = '';
    try {
      const full = (await api.get<{ bundle: Bundle }>(`/mcp/workspaces/${workspaceId}/context-bundles/${bundle.id}`)).bundle;
      savedMessage = '';
      applyBundle(full);
    } catch (err) { error = err instanceof ApiError ? err.message : 'Failed to open bundle'; }
  }
  function addEntry() {
    const clean = cleanPath(picker);
    if (!clean || form.entries.some((item) => cleanPath(item.path) === clean)) return;
    form.entries = [...form.entries, { type: pickerType, path: clean, attachmentType: 'path', recursive: pickerType === 'folder', required: true, priority: 100 }];
    picker = '';
  }
  function addProfile() {
    const profile = profiles.find((item) => item.id === selectedProfileId);
    if (!profile || form.entries.some((item) => item.profileId === profile.id)) return;
    const attachmentPath = cleanPath(profile.sourcePath || profile.fields?.source_file || ('Profiles/' + profile.id));
    form.entries = [...form.entries, {
      type: 'file', path: attachmentPath, attachmentType: 'profile',
      profileId: profile.id, profileName: profile.name,
      recursive: false, required: true, priority: 100
    }];
    selectedProfileId = '';
  }
  function addKnowledge() {
    const item = knowledgeItems.find((entry) => entry.id === selectedKnowledgeId);
    if (!item || form.entries.some((entry) => entry.knowledgeItemId === item.id)) return;
    form.entries = [...form.entries, { type:'knowledge', path:`Library/${item.id}`, attachmentType:'knowledge', knowledgeItemId:item.id, knowledgeItemName:item.name, loadMode:item.loadMode || ((item.roles || []).some((role)=>role==='core_file'||role==='core_profile') ? 'full' : 'smart'), recursive:false, required:true, priority:100 }];
    selectedKnowledgeId = '';
  }
  function removeEntry(target: Entry) {
    form.entries = form.entries.filter((entry) => entry !== target);
  }
  function toggleDependency(bundle: Bundle) {
    if (bundle.id === editingId) return;
    const exists = form.dependencies.some((dep) => dep.bundleId === bundle.id);
    form.dependencies = exists ? form.dependencies.filter((dep) => dep.bundleId !== bundle.id) : [...form.dependencies, { bundleId: bundle.id, name: bundle.name, required: true }];
  }
  async function save() {
    if (!workspaceId || !form.name.trim()) return;
    saving = true; error = ''; savedMessage = '';
    try {
      const result = editingId
        ? await api.put<{ bundle: Bundle }>(`/mcp/workspaces/${workspaceId}/context-bundles/${editingId}`, form)
        : await api.post<{ bundle: Bundle }>(`/mcp/workspaces/${workspaceId}/context-bundles`, form);
      const savedId = result.bundle.id;
      await loadBundles();
      const stored = (await api.get<{ bundle: Bundle }>(
        `/mcp/workspaces/${workspaceId}/context-bundles/${savedId}`
      )).bundle;
      applyBundle(stored);
      savedMessage = 'Bundle saved. Settings and attachments were reloaded from storage.';
    } catch (err) { error = err instanceof ApiError ? err.message : 'Bundle save failed'; }
    finally { saving = false; }
  }
  async function remove(id: string) {
    if (!confirm('Delete this context bundle?')) return;
    await api.delete(`/mcp/workspaces/${workspaceId}/context-bundles/${id}`);
    if (editingId === id) reset();
    await loadBundles();
  }
  load().catch((err) => { error = err instanceof ApiError ? err.message : 'Failed to load CCS bundles'; loading = false; });
</script>

<div class="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 md:p-6">
  <div><h2 class="flex items-center gap-2 text-lg font-semibold"><BookOpen class="size-5" />Bundle Library</h2><p class="text-sm text-muted-foreground">Saved context groups for Base Library knowledge, profiles, files/folders and dependent bundles. OSS presets can attach these without copying or pinning Library source paths.</p></div>
  {#if error}<div class="break-words rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  {#if savedMessage}<div class="break-words rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{savedMessage}</div>{/if}
  {#if workspaces.length === 0}<Card><CardContent class="p-4 text-sm text-muted-foreground">No workspace with OSS/CCS management permission is available.</CardContent></Card>{:else}
    {#if !hideWorkspacePicker}<Card><CardContent class="p-4"><label class="space-y-1 text-sm"><span>Workspace</span><select class="w-full rounded-md border bg-background p-2" bind:value={workspaceId} onchange={() => { reset(); loadBundles(); }}>{#each workspaces as ws}<option value={ws.id}>{ws.name}</option>{/each}</select></label></CardContent></Card>{/if}
    <Card><CardHeader><CardTitle>{editingId ? 'Edit bundle' : 'Create bundle'}</CardTitle></CardHeader><CardContent class="space-y-4">
      <label class="space-y-1 text-sm"><span>Name</span><Input bind:value={form.name} placeholder="Bundle name" /></label>
      <label class="space-y-1 text-sm"><span>Description</span><textarea class="min-h-20 w-full rounded-md border bg-background p-2" bind:value={form.description}></textarea></label>
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={form.enabled} />Enabled</label>
      <div class="space-y-2"><p class="text-sm font-medium">Files and folders</p><div class="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_auto]"><select class="rounded-md border bg-background p-2" bind:value={pickerType}><option value="file">File</option><option value="folder">Folder</option></select><PathPicker bind:value={picker} {workspaceId} /><Button class="w-full sm:w-auto" variant="outline" onclick={addEntry}><Plus class="size-4" />Add</Button></div>
        {#each form.entries.filter((entry) => entry.attachmentType !== 'profile' && entry.attachmentType !== 'knowledge') as entry}<div class="rounded-md border p-3 text-sm"><div class="flex flex-col gap-2 sm:flex-row sm:items-center"><span class="min-w-0 flex-1 break-all">/{entry.path}</span><div class="flex flex-wrap items-center gap-2"><label><input type="checkbox" bind:checked={entry.required} /> Required</label>{#if entry.type === 'folder'}<label><input type="checkbox" bind:checked={entry.recursive} /> Recursive</label>{/if}<input class="w-20 rounded border bg-background p-1" type="number" bind:value={entry.priority} aria-label="Priority" /><Button size="icon" variant="ghost" onclick={() => removeEntry(entry)}><Trash2 class="size-4" /></Button></div></div></div>{/each}
      </div>
      <div class="space-y-2"><p class="text-sm font-medium">Base Library knowledge</p><p class="text-sm text-muted-foreground">Preferred CCS attachment type. Stores the canonical Library Item ID and follows Library lifecycle/load rules instead of pinning a raw path.</p><div class="flex flex-col gap-2 sm:flex-row"><select class="min-w-0 flex-1 rounded-md border bg-background p-2" bind:value={selectedKnowledgeId}><option value="">Select knowledge item</option>{#each knowledgeItems as item}<option value={item.id}>{item.name} · {item.lifecycleState || 'unclassified'}{(item.roles || []).length ? ` · ${(item.roles || []).join(', ')}` : ''}</option>{/each}</select><Button type="button" variant="outline" onclick={addKnowledge} disabled={!selectedKnowledgeId}><Plus class="size-4" />Add knowledge</Button></div>{#each form.entries.filter((entry) => entry.attachmentType === 'knowledge') as entry}<div class="rounded-md border p-3 text-sm"><div class="flex flex-col gap-2 sm:flex-row sm:items-center"><div class="min-w-0 flex-1"><strong class="break-words">{entry.knowledgeItemName || entry.knowledgeItemId || 'Library item'}</strong><p class="text-xs text-muted-foreground">Canonical Library reference · ID {entry.knowledgeItemId || 'missing'}{knowledgeItems.find((item)=>item.id===entry.knowledgeItemId)?.lifecycleState ? ` · ${knowledgeItems.find((item)=>item.id===entry.knowledgeItemId)?.lifecycleState}` : ''}</p>{#if entry.knowledgeItemId && !knowledgeItems.some((item)=>item.id===entry.knowledgeItemId)}<p class="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">Library item is currently unavailable or no longer accessible. Required bundles will fail safely instead of loading the wrong source.</p>{/if}</div><select class="rounded border bg-background p-1 text-xs" bind:value={entry.loadMode}><option value="smart">Smart</option><option value="full">Full</option><option value="summary">Summary</option></select><label class="shrink-0"><input type="checkbox" bind:checked={entry.required} /> Required</label><input class="w-20 rounded border bg-background p-1" type="number" bind:value={entry.priority} aria-label="Priority" /><Button size="icon" variant="ghost" onclick={() => removeEntry(entry)}><Trash2 class="size-4" /></Button></div></div>{/each}{#if knowledgeItems.length === 0}<p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No Base Library knowledge is registered yet.</p>{/if}</div>
      <div class="space-y-2"><p class="text-sm font-medium">Profiles</p><p class="text-sm text-muted-foreground">Add an accessible workspace profile source to this bundle. Existing profile access permissions still apply.</p><div class="flex flex-col gap-2 sm:flex-row"><select class="min-w-0 flex-1 rounded-md border bg-background p-2" bind:value={selectedProfileId}><option value="">Select profile</option>{#each profiles as profile}<option value={profile.id}>{profile.name}</option>{/each}</select><Button type="button" variant="outline" onclick={addProfile} disabled={!selectedProfileId}><Plus class="size-4" />Add profile</Button></div>{#each form.entries.filter((entry) => entry.attachmentType === 'profile') as entry}<div class="rounded-md border p-3 text-sm"><div class="flex items-center gap-2"><div class="min-w-0 flex-1"><strong class="break-words">{entry.profileName || 'Attached profile'}</strong><p class="break-all text-xs text-muted-foreground">/{entry.path}</p></div><label class="shrink-0"><input type="checkbox" bind:checked={entry.required} /> Required</label><Button size="icon" variant="ghost" onclick={() => removeEntry(entry)}><Trash2 class="size-4" /></Button></div></div>{/each}{#if profiles.length === 0}<p class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No accessible profiles with a source file are available.</p>{/if}</div>
      <div class="space-y-2"><p class="text-sm font-medium">Dependencies</p><div class="grid gap-2 sm:grid-cols-2">{#each bundles.filter((item) => item.id !== editingId) as bundle}<label class="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"><span class="min-w-0 break-words">{bundle.name}</span><input type="checkbox" checked={form.dependencies.some((dep) => dep.bundleId === bundle.id)} onchange={() => toggleDependency(bundle)} /></label>{/each}</div></div>
      <div class="flex flex-col gap-2 sm:flex-row"><Button class="w-full sm:w-auto" onclick={save} disabled={saving || !form.name.trim()}>{#if saving}<LoaderCircle class="size-4 animate-spin" />{:else}<Save class="size-4" />{/if}Save bundle</Button>{#if editingId}<Button class="w-full sm:w-auto" variant="outline" onclick={reset}><X class="size-4" />Cancel</Button>{/if}</div>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Bundles</CardTitle></CardHeader><CardContent>{#if loading}<div class="flex justify-center py-10"><LoaderCircle class="size-5 animate-spin" /></div>{:else if bundles.length === 0}<p class="text-sm text-muted-foreground">No context bundles yet.</p>{:else}<div class="grid gap-3 sm:grid-cols-2">{#each bundles as bundle}<div class="rounded-md border p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><strong class="break-words">{bundle.name}</strong><p class="mt-1 break-words text-sm text-muted-foreground">{bundle.description || 'No description'}</p><p class="mt-2 text-xs text-muted-foreground">{bundle.entryCount || 0} entries · {bundle.knowledgeEntryCount || 0} Library · {bundle.profileEntryCount || 0} profiles · {bundle.pathEntryCount || 0} paths · {bundle.dependencyCount || 0} dependencies · v{bundle.version}</p></div><div class="flex shrink-0"><Button size="icon" variant="ghost" onclick={() => editBundle(bundle)}><Pencil class="size-4" /></Button><Button size="icon" variant="ghost" onclick={() => remove(bundle.id)}><Trash2 class="size-4" /></Button></div></div></div>{/each}</div>{/if}</CardContent></Card>
  {/if}
</div>
