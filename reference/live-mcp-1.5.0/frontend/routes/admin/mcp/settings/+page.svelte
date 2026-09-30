<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { addons } from '$lib/addons.svelte';
	import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui';
	import { LoaderCircle, RefreshCw, Server, Database, Plug } from '@lucide/svelte';

	type ServiceStatus = { status?: string; running?: boolean; reachable?: boolean };
	let service = $state<ServiceStatus | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true; error = '';
		try {
			const status = await api.get<{ mcp?: ServiceStatus }>('/system/status');
			service = status.mcp ?? null;
		} catch (err) { error = err instanceof ApiError ? err.message : 'Failed to load MCP status'; }
		finally { loading = false; }
	}
	load();

	const addon = $derived(addons.get('mcp'));
</script>

<div class="mx-auto max-w-4xl space-y-5 p-4 md:p-6">
	<div class="flex items-start justify-between gap-3">
		<div><h1 class="text-xl font-semibold">MCP overview & settings</h1><p class="text-sm text-muted-foreground">Configuration remains available while the MCP service is stopped.</p></div>
		<Button variant="outline" size="sm" onclick={load} disabled={loading}>{#if loading}<LoaderCircle class="size-4 animate-spin" />{:else}<RefreshCw class="size-4" />{/if}Refresh</Button>
	</div>
	{#if error}<div class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
	<div class="grid gap-4 md:grid-cols-3">
		<Card><CardHeader><CardTitle class="flex items-center gap-2"><Plug class="size-4" />Module</CardTitle></CardHeader><CardContent><Badge variant={addon?.attached ? 'success' : 'secondary'}>{addon?.attached ? 'Attached' : 'Detached'}</Badge><p class="mt-2 text-xs text-muted-foreground">Licensed: {addon?.licensed ? 'Yes' : 'No'}</p></CardContent></Card>
		<Card><CardHeader><CardTitle class="flex items-center gap-2"><Server class="size-4" />Service</CardTitle></CardHeader><CardContent><Badge variant={service?.running ? 'success' : 'warning'}>{service?.running ? 'Running' : 'Stopped'}</Badge><p class="mt-2 text-xs text-muted-foreground">Service controls remain under Systems.</p></CardContent></Card>
		<Card><CardHeader><CardTitle class="flex items-center gap-2"><Database class="size-4" />Storage</CardTitle></CardHeader><CardContent><Badge variant="secondary">MySQL</Badge><p class="mt-2 text-xs text-muted-foreground">Root MCP runtime, client registry and sessions use the private Engine database.</p></CardContent></Card>
	</div>
	<Card><CardHeader><CardTitle>Root MCP configuration</CardTitle><CardDescription>System-wide runtime, service, client and diagnostic controls. Workspace context configuration is under MCP → Complex Context System.</CardDescription></CardHeader><CardContent class="grid gap-2 text-sm md:grid-cols-2"><a class="rounded-md border p-3 hover:bg-accent" href="/admin/mcp/runtime">Runtime</a><a class="rounded-md border p-3 hover:bg-accent" href="/admin/mcp/clients">Client registry and access controls</a><a class="rounded-md border p-3 hover:bg-accent" href="/admin/mcp/sessions">Authentication sessions</a><a class="rounded-md border p-3 hover:bg-accent" href="/admin/mcp/logs">MCP-only logs</a></CardContent></Card>
</div>
