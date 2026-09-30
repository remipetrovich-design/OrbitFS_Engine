<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { goto } from '$app/navigation';
	let { path, name, workspaceId, compact = true } = $props<{ path: string; name: string; kind?: string; workspaceId?: string | null; compact?: boolean }>();
	let open = $state(false), busy = $state(false), message = $state(''), failed = $state(false);
	const ws = $derived(workspaceId || 'public');
	async function run(action: 'load' | 'remove') {
		busy = true; message = ''; failed = false;
		try {
			if (action === 'load') await api.post(`/mcp/workspaces/${encodeURIComponent(ws)}/active-context/load-file`, { path });
			else await api.post(`/mcp/workspaces/${encodeURIComponent(ws)}/active-context/remove-file`, { path });
			message = action === 'load' ? 'Loaded into active context' : 'Removed from active context';
		} catch (error) { failed = true; message = error instanceof ApiError ? error.message : 'MCP context action failed'; }
		finally { busy = false; }
	}
	function manage(target: 'context-library' | 'startup' | 'projects') {
		goto(`/mcp/${target}?workspaceId=${encodeURIComponent(ws)}&addPath=${encodeURIComponent(path)}&kind=file`);
		open = false;
	}
</script>
<div class="relative" class:w-full={!compact}>
	<button class={compact ? 'flex size-8 items-center justify-center rounded-md text-cyan-400 hover:bg-cyan-500/15' : 'flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm'} title="MCP context actions" aria-label="MCP context actions for {name}" onclick={(event) => { event.stopPropagation(); open = !open; }}>
		<span aria-hidden="true">⋯</span>{#if !compact}<span>MCP context</span>{/if}
	</button>
	{#if open}
		<div class="absolute right-0 z-50 mt-1 w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
			<div class="flex items-center justify-between px-2 py-1.5 text-xs font-semibold"><span class="truncate">{name}</span><button onclick={() => (open = false)} aria-label="Close">×</button></div>
			<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" disabled={busy} onclick={() => run('load')}>{busy ? 'Loading…' : 'Load into active context'}</button>
			<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => manage('context-library')}>Add to context bundle</button>
			<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => manage('startup')}>Add to Startup</button>
			<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => manage('projects')}>Add to Project</button>
			<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => run('remove')}>Remove from active context</button>
			<button class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onclick={() => goto(`/admin/mcp/runtime?workspaceId=${encodeURIComponent(ws)}`)}>View context status</button>
			{#if message}<p class="mt-1 rounded px-2 py-1 text-xs" class:text-destructive={failed} class:text-emerald-400={!failed}>{message}</p>{/if}
		</div>
	{/if}
</div>
