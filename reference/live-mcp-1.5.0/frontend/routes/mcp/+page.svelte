<script lang="ts">
	import { Plug, Sparkles, Folder, FolderKanban } from '@lucide/svelte';
</script>

<div class="mx-auto max-w-3xl space-y-6 p-4 md:p-6">
	<div>
		<h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
			<Plug class="size-5 text-muted-foreground" />
			MCP
		</h1>
		<p class="text-sm text-muted-foreground">Manage the attached OrbitFS MCP add-on and its separate server engine.</p>
	</div>

	<div class="grid gap-3 sm:grid-cols-3">
		<a href="/mcp/oss" class="rounded-md border bg-card p-4 hover:bg-muted/40">
			<Sparkles class="mb-3 size-5 text-primary" />
			<div class="font-medium">OrbitFS Startup System (OSS)</div>
			<div class="mt-1 text-sm text-muted-foreground">Configure ChatGPT Startup presets, names, buttons and load contents.</div>
		</a>
		<a href="/mcp/projects" class="rounded-md border bg-card p-4 hover:bg-muted/40">
			<Folder class="mb-3 size-5 text-primary" />
			<div class="font-medium">Projects</div>
			<div class="mt-1 text-sm text-muted-foreground">Manage reusable AI behaviour, startup instructions, files, folders and bundle assignments.</div>
		</a>
		<a href="/mcp/ccs" class="rounded-md border bg-card p-4 hover:bg-muted/40">
			<FolderKanban class="mb-3 size-5 text-primary" />
			<div class="font-medium">Complex Context System (CCS)</div>
			<div class="mt-1 text-sm text-muted-foreground">Create bundles and manage their profiles, files, folders, permissions and settings.</div>
		</a>
	</div>
</div>
