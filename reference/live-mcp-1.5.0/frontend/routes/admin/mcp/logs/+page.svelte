<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui';
	import { LoaderCircle, RefreshCw, ScrollText } from '@lucide/svelte';

	const LOG_TABS: { key: string; label: string }[] = [
		{ key: 'hive-events', label: 'MCP events' },
		{ key: 'hive-errors', label: 'MCP errors' },
		{ key: 'hive-out', label: 'MCP stdout' },
		{ key: 'hive-err', label: 'MCP stderr' }
	];

	let activeLog = $state(LOG_TABS[0].key);
	let logLines = $state<string[]>([]);
	let logPath = $state('');
	let loading = $state(true);
	let error = $state('');

	async function loadLog(which = activeLog) {
		activeLog = which;
		loading = true;
		error = '';
		try {
			const res = await api.get<{ lines: string[]; error?: string; path?: string }>(
				`/system/logs?which=${encodeURIComponent(which)}`
			);
			logLines = res.lines ?? [];
			logPath = res.path ?? '';
			error = res.error ?? '';
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Failed to load MCP logs';
			logLines = [];
			logPath = '';
		} finally {
			loading = false;
		}
	}

	loadLog();
</script>

<div class="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
				<ScrollText class="size-5 text-muted-foreground" />
				MCP Logs
			</h1>
			<p class="text-sm text-muted-foreground">
				Direct access to the live MCP engine logs. This page stays visible so the add-on can be debugged in
				place.
			</p>
		</div>
		<Button variant="outline" size="sm" onclick={() => loadLog()}>
			<RefreshCw class="size-4" />
			Refresh
		</Button>
	</div>

	<Card>
		<CardHeader>
			<CardTitle>Runtime streams</CardTitle>
			<CardDescription>Switch between MCP event, error, stdout, and stderr output.</CardDescription>
		</CardHeader>
		<CardContent class="space-y-4">
			<div class="flex flex-wrap gap-1.5">
				{#each LOG_TABS as tab (tab.key)}
					<button
						class="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors {activeLog === tab.key
							? 'border-primary bg-primary/15 text-primary'
							: 'border-border text-muted-foreground hover:bg-accent'}"
						onclick={() => loadLog(tab.key)}
					>
						{tab.label}
					</button>
				{/each}
			</div>

			<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<Badge variant="outline">{activeLog}</Badge>
				{#if logPath}
					<span>Source: <code>{logPath}</code></span>
				{/if}
			</div>

			<div class="h-[34rem] overflow-y-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
				{#if loading}
					<div class="flex items-center gap-2 text-muted-foreground">
						<LoaderCircle class="size-4 animate-spin" />
						Loading logs...
					</div>
				{:else if error}
					<p class="text-destructive">{error}</p>
				{:else if logLines.length === 0}
					<p class="text-muted-foreground">No log lines.</p>
				{:else}
					{#each logLines as line, i (i)}
						<div class="whitespace-pre-wrap break-all text-muted-foreground">{line}</div>
					{/each}
				{/if}
			</div>
		</CardContent>
	</Card>
</div>
