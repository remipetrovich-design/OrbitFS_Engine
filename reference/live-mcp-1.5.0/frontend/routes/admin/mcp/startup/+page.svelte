<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api';
  import { Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
  let policy=$state<any>(null),loading=$state(true),saving=$state(false),error=$state(''),saved=$state('');
  async function load(){loading=true;error='';try{policy=(await api.get<any>('/mcp/admin-policy')).policy;}catch(e){error=e instanceof ApiError?e.message:'Unable to load OSS policy';}finally{loading=false;}}
  async function save(){saving=true;error='';saved='';try{policy=(await api.put<any>('/mcp/admin-policy',{policy})).policy;saved='OSS policy saved and applied.';}catch(e){error=e instanceof ApiError?e.message:'Unable to save OSS policy';}finally{saving=false;}}
  function toggleStrength(key:string){const values=policy.oss.allowedStrengths||[];policy.oss.allowedStrengths=values.includes(key)?values.filter((v:string)=>v!==key):[...values,key];}
  onMount(load);
</script>
<div class="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
  <div><h1 class="text-xl font-semibold">OrbitFS Startup System Admin</h1><p class="text-sm text-muted-foreground">Root defaults and enforced limits. Workspace presets remain under MCP → OSS.</p></div>
  {#if error}<div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  {#if saved}<div class="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">{saved}</div>{/if}
  {#if loading}<p>Loading…</p>{:else if policy}
  <Card><CardHeader><CardTitle>Availability and preset buttons</CardTitle></CardHeader><CardContent class="space-y-4">
    <label class="flex items-center gap-2"><input type="checkbox" bind:checked={policy.oss.enabled}/> Enable OSS</label>
    <label class="flex items-center gap-2"><input type="checkbox" bind:checked={policy.oss.allowCustomNames}/> Allow custom preset/button names</label>
    <div><span class="text-sm font-medium">Allowed strengths</span><div class="mt-2 flex flex-wrap gap-3">{#each ['low','medium','high','custom1','custom2'] as key}<label class="flex items-center gap-2"><input type="checkbox" checked={policy.oss.allowedStrengths.includes(key)} onchange={()=>toggleStrength(key)}/>{key}</label>{/each}</div></div>
    <label class="grid gap-1 text-sm">Default strength<select class="rounded-md border bg-background p-2" bind:value={policy.oss.defaultStrength}>{#each policy.oss.allowedStrengths as key}<option value={key}>{key}</option>{/each}</select></label>
  </CardContent></Card>
  <Card><CardHeader><CardTitle>Enforced startup limits</CardTitle></CardHeader><CardContent class="grid gap-4 sm:grid-cols-2">
    <label class="grid gap-1 text-sm">Maximum preset name length<input class="rounded-md border bg-background p-2" type="number" min="1" max="80" bind:value={policy.oss.maxPresetNameLength}/></label>
    <label class="grid gap-1 text-sm">Maximum bundles per preset<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.oss.maxBundlesPerPreset}/></label>
    <label class="grid gap-1 text-sm">Maximum files per startup<input class="rounded-md border bg-background p-2" type="number" min="1" bind:value={policy.oss.maxFilesPerStartup}/></label>
    <label class="grid gap-1 text-sm">Maximum characters per startup<input class="rounded-md border bg-background p-2" type="number" min="1000" bind:value={policy.oss.maxCharactersPerStartup}/></label>
    <label class="grid gap-1 text-sm">Maximum load duration (seconds)<input class="rounded-md border bg-background p-2" type="number" min="1" max="600" bind:value={policy.oss.maxLoadSeconds}/></label>
  </CardContent></Card>
  <div class="flex justify-end"><Button onclick={save} disabled={saving}>{saving?'Saving…':'Save and apply OSS policy'}</Button></div>
  {/if}
</div>