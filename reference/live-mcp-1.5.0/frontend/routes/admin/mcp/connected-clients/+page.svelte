<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  onMount(() => goto('/admin/mcp/clients', { replaceState: true }));
</script>
<p class="p-6 text-sm text-muted-foreground">Opening MCP Client Registry…</p>