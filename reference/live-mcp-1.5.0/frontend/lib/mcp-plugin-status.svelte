<script lang="ts">
	import { addons } from '$lib/addons.svelte';
	const addon = $derived(addons.get('mcp'));
</script>
<span data-orbitfs-plugin="mcp" data-installed={addon?.installed} data-licensed={addon?.licensed} data-attached={addon?.attached}></span>
