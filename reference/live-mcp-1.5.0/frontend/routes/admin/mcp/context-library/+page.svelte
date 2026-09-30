<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api';
  import { Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
  let policy=$state<any>(null),loading=$state(true),saving=$state(false),error=$state(''),saved=$state('');
  async function load(){loading=true;error='';try{policy=(await api.get<any>('/mcp/admin-policy')).policy;}catch(e){error=e instanceof ApiError?e.message:'Unable to load CCS policy';}finally{loading=false;}}
  async function save(){saving=true;error='';saved='';try{policy=(await api.put<any>('/mcp/admin-policy',{policy})).policy;saved='CCS and registry policy saved and applied.';}catch(e){error=e instanceof ApiError?e.message:'Unable to save CCS policy';}finally{saving=false;}}
  onMount(load);
</script>
<div class="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
  <div><h1 class="text-xl font-semibold">Complex Context System Admin</h1><p class="text-sm text-muted-foreground">Root bundle, context and profile limits. Workspace bundle contents remain under MCP → CCS.</p></div>
  {#if error}<div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  {#if saved}<div class="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">{saved}</div>{/if}
  {#if loading}<p>Loading…</p>{:else if policy}
  <Card><CardHeader><CardTitle>Availability</CardTitle></CardHeader><CardContent class="flex flex-wrap gap-6">
    <label class="flex items-center gap-2"><input type="checkbox" bind:checked={policy.ccs.enabled}/> Enable CCS</label>
    <label class="flex items-center gap-2"><input type="checkbox" bind:checked={policy.ccs.allowProfiles}/> Allow accessible profiles in bundles</label>
  </CardContent></Card>
  <Card><CardHeader><CardTitle>Enforced bundle and context limits</CardTitle></CardHeader><CardContent class="grid gap-4 sm:grid-cols-2">
    <label class="grid gap-1 text-sm">Bundles per workspace<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.ccs.maxBundlesPerWorkspace}/></label>
    <label class="grid gap-1 text-sm">Entries per bundle<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.ccs.maxEntriesPerBundle}/></label>
    <label class="grid gap-1 text-sm">Dependencies per bundle<input class="rounded-md border bg-background p-2" type="number" min="0" bind:value={policy.ccs.maxDependenciesPerBundle}/></label>
    <label class="grid gap-1 text-sm">Dependency depth<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.ccs.maxDependencyDepth}/></label>
    <label class="grid gap-1 text-sm">Maximum document/image bytes<input class="rounded-md border bg-background p-2" type="number" min="1048576" bind:value={policy.ccs.maxDocumentFileBytes}/></label>
    <label class="grid gap-1 text-sm">Maximum audio/video source bytes<input class="rounded-md border bg-background p-2" type="number" min="10485760" bind:value={policy.ccs.maxMediaFileBytes}/></label>
    <label class="grid gap-1 text-sm">Maximum media output bytes per load<input class="rounded-md border bg-background p-2" type="number" min="1048576" bind:value={policy.ccs.maxMediaOutputBytes}/></label>
    <label class="grid gap-1 text-sm">Maximum bundle characters<input class="rounded-md border bg-background p-2" type="number" min="1000" bind:value={policy.ccs.maxBundleCharacters}/></label>
    <label class="grid gap-1 text-sm">Folder recursion depth<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.ccs.maxFolderDepth}/></label>
  </CardContent></Card>
  <Card><CardHeader><CardTitle>Client Registry retention and sessions</CardTitle></CardHeader><CardContent class="grid gap-4 sm:grid-cols-2">
    <label class="grid gap-1 text-sm">Active sessions per client<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.registry.maxActiveSessionsPerClient}/></label>
    <label class="grid gap-1 text-sm">Session idle timeout (minutes)<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.registry.sessionIdleMinutes}/></label>
    <label class="grid gap-1 text-sm">Recent connections (days)<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.registry.recentConnectionDays}/></label>
    <label class="grid gap-1 text-sm">History retention (days)<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.registry.historyRetentionDays}/></label>
  </CardContent></Card>
  <div class="flex justify-end"><Button onclick={save} disabled={saving}>{saving?'Saving…':'Save and apply policy'}</Button></div>
  {/if}
</div>