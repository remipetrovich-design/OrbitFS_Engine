<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  onMount(() => goto(`/mcp/oss${page.url.search}`, { replaceState: true }));
</script>
<p class="p-6 text-sm text-muted-foreground">Opening OrbitFS Startup System...</p>
