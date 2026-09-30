<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { goto } from '$app/navigation';
	let { path, name, workspaceId } = $props<{ path: string; name: string; kind?: string; workspaceId?: string | null }>();
	let open = $state(false), busy = $state(false), message = $state(''), failed = $state(false);
	const ws = $derived(workspaceId || 'public');
	async function loadFolder() { busy = true; message = ''; failed = false; try { const result = await api.post<any>(`/mcp/workspaces/${encodeURIComponent(ws)}/active-context/load-folder`, { path, maxFiles: 100 }); const count = result.loaded?.length || 0; message = count > 0 ? `Loaded ${count} file(s) into active context` : 'Folder loaded successfully — it is currently empty'; } catch (error) { failed = true; message = error instanceof ApiError ? error.message : 'Folder context load failed'; } finally { busy = false; } }
	function manage(target: string) { goto(`/mcp/${target}?workspaceId=${encodeURIComponent(ws)}&addPath=${encodeURIComponent(path)}&kind=folder`); open = false; }
</script>
<div class="relative">
	<button class="flex size-8 items-center justify-center rounded-md text-cyan-400 hover:bg-cyan-500/15" title="MCP folder context actions" aria-label="MCP context actions for {name}" onclick={(event) => { event.stopPropagation(); open = !open; }}><span aria-hidden="true">⋯</span></button>
	{#if open}<div class="absolute right-0 z-50 mt-1 w-64 rounded-md border bg-popover p-1 shadow-lg">
		<div class="flex items-center justify-between px-2 py-1.5 text-xs font-semibold"><span class="truncate">{name}</span><button onclick={() => (open = false)} aria-label="Close">×</button></div>
		<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" disabled={busy} onclick={loadFolder}>{busy ? 'Loading…' : 'Load folder into active context'}</button>
		<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => manage('context-library')}>Add folder to context bundle</button>
		<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => manage('startup')}>Add folder to Startup</button>
		<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => manage('projects')}>Add folder to Project</button>
		<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => goto(`/admin/mcp/runtime?workspaceId=${encodeURIComponent(ws)}`)}>View context status</button>
		{#if message}<p class="mt-1 rounded px-2 py-1 text-xs" class:text-destructive={failed} class:text-emerald-400={!failed}>{message}</p>{/if}
	</div>{/if}
</div>
