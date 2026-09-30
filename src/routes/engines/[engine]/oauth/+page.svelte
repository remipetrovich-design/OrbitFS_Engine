<script lang="ts">
	let { data, form } = $props();
	const engine=data.engine;
	const endpoints=data.endpoints || { issuer:'', resource:'', authorization:'', token:'', registration:'', scopes:[] };
	const now=Date.now();
	const active=(token:any)=>!token.revoked_at && new Date(token.expires_at).getTime()>now;
	const activeCount=data.tokens.filter(active).length;
	const fmt=(value:any)=>value?new Date(value).toLocaleString():'Never';
	const scopeHelp:Record<string,string>={
		'orbitfs:read':'Read authorised OrbitFS workspace context and data.',
		'orbitfs:write':'Perform write operations when the client and workspace allow them.',
		'offline_access':'Allow refresh tokens so the client can renew access.'
	};
</script>

<svelte:head><title>{engine.name} OAuth · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="shell">
	<header><a href="/engines">OrbitFS Engine Host</a><nav><a href={`/engines/${engine.id}`}>{engine.name}</a><b>OAuth</b></nav></header>
	<main>
		<div class="title"><div><small>MCP AUTHENTICATION</small><h1>OAuth</h1><p>Panel is the identity authority. Manage the MCP resource, clients and issued access here.</p></div><a href={`/engines/${engine.id}`}>Back to engine</a></div>

		{#if !data.applicable}<div class="notice">OAuth applies to MCP only.</div>{:else}
			{#if form?.error}<div class="notice error">{form.error}</div>{/if}
			{#if form?.message}<div class="notice ok">{form.message}</div>{/if}

			<div class="facts">
				<span><small>Clients</small><b>{data.clients.length}</b></span>
				<span><small>Active tokens</small><b>{activeCount}</b></span>
				<span><small>Authority</small><b>{endpoints.issuer}</b></span>
				<span><small>Resource</small><b>{endpoints.resource}</b></span>
			</div>

			<section>
				<h2>Published endpoints</h2>
				<dl><dt>Issuer</dt><dd><code>{endpoints.issuer}</code></dd><dt>Resource</dt><dd><code>{endpoints.resource}</code></dd><dt>Authorization</dt><dd><code>{endpoints.authorization}</code></dd><dt>Token</dt><dd><code>{endpoints.token}</code></dd><dt>Dynamic registration</dt><dd><code>{endpoints.registration}</code></dd></dl>
			</section>

			<section>
				<h2>Scopes</h2>
				<div class="scope-list">{#each endpoints.scopes as scope}<div><code>{scope}</code><span>{scopeHelp[scope] || 'OrbitFS MCP scope.'}</span></div>{/each}</div>
			</section>

			<section>
				<div class="section-title"><h2>Registered clients</h2><span>{data.clients.length}</span></div>
				{#if data.clients.length}
					<div class="clients">{#each data.clients as client}<article><div class="client-title"><div><b>{client.client_name || client.client_id}</b><code>{client.client_id}</code></div><form method="POST" action="?/revoke"><input type="hidden" name="clientId" value={client.client_id}/><button>Revoke active tokens</button></form></div><dl><dt>Scope</dt><dd>{client.scope || 'orbitfs:read'}</dd><dt>Redirect URIs</dt><dd>{Array.isArray(client.redirect_uris)?client.redirect_uris.join(', '):'None'}</dd><dt>Application type</dt><dd>{client.application_type || 'web'}</dd><dt>Updated</dt><dd>{fmt(client.updated_at || client.created_at)}</dd></dl></article>{/each}</div>
				{:else}<p class="empty">No OAuth clients registered.</p>{/if}
			</section>

			<section>
				<div class="section-title"><h2>Recent grants</h2><span>Token values are hidden</span></div>
				{#if data.tokens.length}<div class="token-table"><div class="token-row head"><span>Client</span><span>Scope</span><span>Status</span><span>Last used</span></div>{#each data.tokens.slice(0,50) as token}<div class="token-row"><span>{token.client_id}</span><span>{token.scope}</span><span>{active(token)?'Active':token.revoked_at?'Revoked':'Expired'}</span><span>{fmt(token.last_used_at)}</span></div>{/each}</div>{:else}<p class="empty">No OAuth tokens issued.</p>{/if}
			</section>
		{/if}

		<div class="links"><a href={`/engines/${engine.id}/configuration`}>Configuration</a><a href={`/engines/${engine.id}/connections`}>Connections</a><a href={`/engines/${engine.id}/monitoring`}>Monitoring</a><a href={`/engines/${engine.id}/logs`}>Logs</a></div>
	</main>
</div>

<style>
	.shell{min-height:100vh}header{height:54px;border-bottom:1px solid #25282d;display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:#0b0d10}header>a{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:8px;font-size:10px;color:#777}nav a{color:#aaa;text-decoration:none}main{max-width:1000px;margin:0 auto;padding:34px 18px 60px}.title{display:flex;justify-content:space-between;align-items:end;gap:16px;border-bottom:1px solid #25282d;padding-bottom:18px}.title small{font-size:9px;color:#777;letter-spacing:.14em}.title h1{font-size:28px;margin:4px 0}.title p{margin:0;color:#858b92;font-size:12px}.title>a{color:#aaa;text-decoration:none;font-size:10px}.notice{padding:10px 12px;border:1px solid #343940;margin:14px 0;font-size:11px}.notice.error{border-color:#6a3030;color:#f3b4b4}.notice.ok{border-color:#2f6646;color:#9de2b8}.facts{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #25282d;margin:18px 0}.facts span{padding:10px;border-right:1px solid #25282d;min-width:0}.facts span:last-child{border-right:0}.facts small{display:block;color:#737980;font-size:8px;text-transform:uppercase}.facts b{display:block;margin-top:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}section{border:1px solid #25282d;background:#0c0f12;padding:16px;margin-top:14px}section h2{font-size:15px;margin:0}.section-title{display:flex;justify-content:space-between;gap:12px;align-items:center}.section-title>span{font-size:8px;color:#777}dl{display:grid;grid-template-columns:140px 1fr;gap:8px 12px;font-size:10px;margin:12px 0 0}dt{color:#747a81}dd{margin:0;min-width:0;word-break:break-word}code{word-break:break-all}.scope-list{display:grid;margin-top:10px}.scope-list>div{display:grid;grid-template-columns:150px 1fr;gap:12px;padding:9px 0;border-top:1px solid #23262b}.scope-list>div:first-child{border-top:0}.scope-list code{font-size:9px}.scope-list span{font-size:9px;color:#777}.clients{display:grid}.clients article{padding:14px 0;border-top:1px solid #23262b}.clients article:first-child{border-top:0}.client-title{display:flex;justify-content:space-between;gap:12px;align-items:start}.client-title>div{display:grid;gap:3px}.client-title b{font-size:11px}.client-title code{font-size:8px;color:#777}button{background:#111;border:1px solid #3a3f46;color:#ddd;padding:6px 9px;font-size:9px;cursor:pointer}.token-table{overflow:auto;margin-top:10px}.token-row{min-width:700px;display:grid;grid-template-columns:1.2fr 1.4fr .7fr 1.1fr;gap:10px;padding:9px 4px;border-top:1px solid #23262b;font-size:9px}.token-row.head{border-top:0;text-transform:uppercase;color:#777;font-size:8px}.empty{font-size:10px;color:#777}.links{display:flex;gap:7px;flex-wrap:wrap;margin-top:16px}.links a{border:1px solid #30343a;color:#aaa;text-decoration:none;padding:7px 9px;font-size:9px}@media(max-width:700px){.facts{grid-template-columns:1fr}.facts span{border-right:0;border-bottom:1px solid #25282d}.facts span:last-child{border-bottom:0}.title{align-items:start;flex-direction:column}.scope-list>div,dl{grid-template-columns:1fr}.client-title{flex-direction:column}}
</style>
