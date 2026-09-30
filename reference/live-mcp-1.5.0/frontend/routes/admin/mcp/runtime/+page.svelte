<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
  import { Activity, KeyRound, RefreshCw, Server, Settings } from '@lucide/svelte';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let message = $state('');
  let status: any = $state(null);
  let control: any = $state({ configured: false });
  let controlToken = $state('');

  async function load() {
    loading = true; error = '';
    try {
      try { status = await api.get('/mcp/runtime'); }
      catch {
        const system: any = await api.get('/system/status');
        status = { ...(system?.mcp || {}), mode: 'workspace', workspaceIntegration: true, serviceName: 'OrbitFSMcpServer', port: 3939, connectorPath: '/mcp' };
      }
      try { control = await api.get('/mcp/runtime/control-token'); }
      catch { control = { configured: Boolean(status?.controlTokenConfigured) }; }
    } catch (e) { error = e instanceof Error ? e.message : 'Unable to load MCP runtime'; }
    finally { loading = false; }
  }

  async function saveToken(generate = false) {
    saving = true; error = ''; message = '';
    try {
      control = await api.put('/mcp/runtime/control-token', generate ? { generate: true } : { token: controlToken });
      controlToken = '';
      message = 'MCP Control Token saved and MCP service restarted.';
      await load();
    } catch (e) { error = e instanceof Error ? e.message : 'Unable to save MCP Control Token'; }
    finally { saving = false; }
  }

  onMount(load);
</script>

<div class="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
  <div class="flex items-center justify-between gap-3"><div><h1 class="flex items-center gap-2 text-xl font-semibold"><Server class="size-5" />MCP Runtime</h1><p class="text-sm text-muted-foreground">Engine, connector, control access and service status.</p></div><Button variant="outline" onclick={load} disabled={loading}><RefreshCw class="size-4" />Refresh</Button></div>
  {#if error}<div class="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  {#if message}<div class="rounded-lg border border-green-500/40 bg-green-500/10 p-3 text-sm text-green-700">{message}</div>{/if}

  <div class="grid gap-4 md:grid-cols-2">
    <Card><CardHeader><CardTitle class="flex items-center gap-2"><Activity class="size-4" />Runtime state</CardTitle></CardHeader><CardContent class="space-y-2 text-sm"><div class="flex justify-between"><span>Online</span><Badge variant={status?.online?'default':'destructive'}>{status?.online?'Online':'Offline'}</Badge></div><div class="flex justify-between"><span>Mode</span><span>{status?.mode || 'unknown'}</span></div><div class="flex justify-between"><span>Service</span><span>{status?.serviceName || 'OrbitFSMcpServer'}</span></div><div class="flex justify-between"><span>Port</span><span>{status?.port || 3939}</span></div></CardContent></Card>
    <Card><CardHeader><CardTitle class="flex items-center gap-2"><Settings class="size-4" />Connector</CardTitle></CardHeader><CardContent class="space-y-2 text-sm"><div class="flex justify-between"><span>Licence</span><span>{status?.licensed?'Allowed':'Blocked'}</span></div><div class="flex justify-between"><span>Attached</span><span>{status?.attached?'Yes':'No'}</span></div><div class="flex justify-between"><span>ChatGPT path</span><code>{status?.connectorPath || '/mcp'}</code></div><div class="flex justify-between"><span>Workspace integration</span><span>{status?.workspaceIntegration?'Active':'Public fallback'}</span></div></CardContent></Card>
  </div>

  <Card>
    <CardHeader><CardTitle class="flex items-center gap-2"><KeyRound class="size-4" />MCP Control Token</CardTitle></CardHeader>
    <CardContent class="space-y-4">
      <div class="flex items-center justify-between text-sm"><span>Status</span><Badge variant={control?.configured?'default':'destructive'}>{control?.configured?'Configured':'Not configured'}</Badge></div>
      <label class="block space-y-1 text-sm"><span>New control token</span><input class="w-full rounded-md border bg-background p-2 font-mono" type="password" autocomplete="new-password" bind:value={controlToken} placeholder="Enter at least 32 characters" /></label>
      <p class="text-xs text-muted-foreground">Used internally by the panel to manage the MCP Client Registry. The saved token is never shown again.</p>
      <div class="flex flex-col gap-2 sm:flex-row"><Button onclick={() => saveToken(false)} disabled={saving || controlToken.trim().length < 32}>Save token</Button><Button variant="outline" onclick={() => saveToken(true)} disabled={saving}>Generate secure token</Button></div>
    </CardContent>
  </Card>
</div>
