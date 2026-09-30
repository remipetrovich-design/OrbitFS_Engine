<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api';
  import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
  import { Plug, RefreshCw, ShieldBan, Unplug, Users } from '@lucide/svelte';
  type Client={clientId:string;clientName:string;status:string;createdAt:string;lastSeenAt?:string;activeTokens:number;users:string[];workspaceIds:string[];permissions:{read:boolean;write:boolean};redirectUris:string[]};
  type Session={id:string;username:string;workspaceId?:string;provider:string;status:string;connectedAt:string;lastSeenAt:string;idle:boolean;requestCount:number};
  let tab=$state<'clients'|'connected'|'recent'|'sessions'>('clients'),loading=$state(true),error=$state('');
  let clients=$state<Client[]>([]),connected=$state<Session[]>([]),recent=$state<Session[]>([]),sessions=$state<Session[]>([]);
  const date=(value?:string)=>value?new Date(value).toLocaleString():'Never';
  async function load(){loading=true;error='';try{const data=await api.get<{clients:Client[];connected:Session[];recent:Session[];sessions:Session[]}>('/mcp/registry');clients=data.clients||[];connected=data.connected||[];recent=data.recent||[];sessions=data.sessions||[];}catch(err){error=err instanceof ApiError?err.message:'Unable to load MCP registry';}finally{loading=false;}}
  async function update(client:Client,patch:any){try{await api.patch(`/mcp/registry/clients/${encodeURIComponent(client.clientId)}`,patch);await load();}catch(err){error=err instanceof Error?err.message:'Update failed';}}
  async function disconnectClient(client:Client){if(!confirm(`Disconnect ${client.clientName} and revoke its active tokens?`))return;await api.post(`/mcp/registry/clients/${encodeURIComponent(client.clientId)}/disconnect`,{});await load();}
  async function disconnectSession(session:Session){if(!confirm('Disconnect this MCP session?'))return;await api.post(`/mcp/registry/sessions/${encodeURIComponent(session.id)}/disconnect`,{});await load();}
  onMount(load);
</script>

<div class="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 md:p-6">
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h1 class="flex items-center gap-2 text-xl font-semibold"><Users class="size-5"/>MCP Client Registry</h1><p class="text-sm text-muted-foreground">Registered clients, current connections and session history.</p></div><Button variant="outline" onclick={load} disabled={loading}><RefreshCw class={loading ? "size-4 animate-spin" : "size-4"}/>Refresh</Button></div>
  {#if error}<div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
  <div class="flex flex-wrap gap-2"><Button variant={tab==='clients'?'default':'outline'} onclick={()=>tab='clients'}>Clients <Badge variant="secondary">{clients.length}</Badge></Button><Button variant={tab==='connected'?'default':'outline'} onclick={()=>tab='connected'}>Connected <Badge variant="secondary">{connected.length}</Badge></Button><Button variant={tab==='recent'?'default':'outline'} onclick={()=>tab='recent'}>Recent Connections <Badge variant="secondary">{recent.length}</Badge></Button><Button variant={tab==='sessions'?'default':'outline'} onclick={()=>tab='sessions'}>Sessions <Badge variant="secondary">{sessions.length}</Badge></Button></div>  {#if loading}<Card><CardContent class="flex justify-center py-12"><RefreshCw class="size-6 animate-spin"/></CardContent></Card>
  {:else if tab==='clients'}
    <div class="space-y-3">{#each clients as client}
      <Card><CardHeader><div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><CardTitle class="break-all">{client.clientName}</CardTitle><code class="text-xs text-muted-foreground">{client.clientId}</code></div><Badge variant={client.status==='active'?'default':'destructive'}>{client.status}</Badge></div></CardHeader>
      <CardContent class="space-y-3 text-sm"><div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><div><span class="text-muted-foreground">Created</span><p>{date(client.createdAt)}</p></div><div><span class="text-muted-foreground">Last seen</span><p>{date(client.lastSeenAt)}</p></div><div><span class="text-muted-foreground">Tokens</span><p>{client.activeTokens}</p></div><div><span class="text-muted-foreground">Workspaces</span><p>{client.workspaceIds.length}</p></div></div>
      <div class="flex flex-wrap gap-4"><label class="flex items-center gap-2"><input type="checkbox" checked={client.permissions?.read!==false} onchange={(e)=>update(client,{permissions:{...client.permissions,read:e.currentTarget.checked}})}/>Read</label><label class="flex items-center gap-2"><input type="checkbox" checked={client.permissions?.write!==false} onchange={(e)=>update(client,{permissions:{...client.permissions,write:e.currentTarget.checked}})}/>Write</label></div>
      {#if client.users?.length}<p><span class="text-muted-foreground">Users:</span> {client.users.join(', ')}</p>{/if}
      <div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" onclick={()=>disconnectClient(client)}><Unplug class="size-4"/>Disconnect</Button>{#if client.status==='active'}<Button size="sm" variant="destructive" onclick={()=>update(client,{status:'blocked'})}><ShieldBan class="size-4"/>Block</Button><Button size="sm" variant="destructive" onclick={()=>update(client,{status:'revoked'})}>Revoke</Button>{:else}<Button size="sm" onclick={()=>update(client,{status:'active'})}>Re-enable</Button>{/if}</div>
      </CardContent></Card>
    {:else}<Card><CardContent class="py-10 text-center text-sm text-muted-foreground">No MCP clients registered.</CardContent></Card>{/each}</div>  {:else}
    {@const rows=tab==='connected'?connected:tab==='recent'?recent:sessions}
    <div class="space-y-3">{#each rows as session}
      <Card><CardContent class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><strong>{session.username||'Unknown user'}</strong><Badge variant={session.status==='active'&&!session.idle?'default':'secondary'}>{session.idle?'idle':session.status}</Badge></div><p class="break-all text-xs text-muted-foreground">{session.id} · {session.provider} · {session.workspaceId||'No workspace'}</p><p class="text-xs text-muted-foreground">Connected {date(session.connectedAt)} · Last seen {date(session.lastSeenAt)} · {session.requestCount||0} requests</p></div>{#if session.status==='active'}<Button variant="destructive" size="sm" onclick={()=>disconnectSession(session)}><Unplug class="size-4"/>Disconnect</Button>{/if}</CardContent></Card>
    {:else}<Card><CardContent class="py-10 text-center text-sm text-muted-foreground">No {tab==='connected'?'connected clients':tab==='recent'?'recent connections':'session history'}.</CardContent></Card>{/each}</div>
  {/if}
</div>