<script lang="ts">
	import FileActions from './file-actions.svelte';
	let { path, name, workspaceId } = $props<{ path: string; name: string; kind?: string; workspaceId?: string | null }>();
</script>
<div class="fixed right-20 top-3 z-[70]"><FileActions {path} {name} {workspaceId} compact={false} /></div>
