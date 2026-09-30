<script lang="ts">
	let { data, form } = $props();
	let providerBase = $state(data.connection?.providerBase || '');
	const connections = data.connection?.officialConnections || [];
</script>

<svelte:head><title>API Connections · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="shell">
	<header><a href="/engines">OrbitFS Engine Host</a><nav><a href="/engines">Engines</a><a href="/configuration">Host configuration</a><b>API connections</b><a href={data.connection?.registryAuthority || 'https://incendiarynetworks.cc/api/v1'}>Registry</a></nav></header>
	<main>
		<div class="title"><div><small>HOST CONFIGURATION</small><h1>API Connections</h1><p>Select the official OrbitFS licence API used by this Engine Host. Random URLs are rejected server-side.</p></div><span>Official only</span></div>

		<section>
			<div class="section-title"><div><h2>Licence runtime API</h2><p>Validation, pulse, entitlement and check-in traffic uses this selected endpoint.</p></div><span>{connections.length} approved</span></div>
			<form method="POST" class="form-grid">
				<label><span>Official API URL</span><input name="providerBase" bind:value={providerBase} list="official-engine-apis" placeholder="https://incendiarynetworks.cc/api/v1/license" /></label>
				<datalist id="official-engine-apis">{#each connections as connection}<option value={connection.base_url}>{connection.label}</option>{/each}</datalist>
				<div class="buttons"><button type="submit" formaction="?/save">Save official API</button><button type="submit" formaction="?/test">Test connection</button>{#if connections.length}<button type="button" onclick={()=>providerBase=connections[0].base_url}>Use recommended</button>{/if}</div>
			</form>
			<p class="help">You can paste/type a URL, but it only saves when it exactly matches an enabled <code>v1_engine</code> licence runtime endpoint published by License Manager.</p>
			{#if form?.message}<div class="notice ok">{form.message}{#if form?.diagnostics?.master?.status} · HTTP {form.diagnostics.master.status}{/if}</div>{/if}
			{#if form?.error}<div class="notice error">{form.error}</div>{/if}
		</section>

		<section>
			<div class="section-title"><div><h2>Approved endpoints</h2><p>Read from the immutable License Manager registry trust anchor.</p></div><span>{data.connection?.registryAuthority || 'License Manager'}</span></div>
			<div class="connection-list">
				{#each connections as connection}
					<div class="connection">
						<div><b>{connection.label}</b><code>{connection.base_url}</code><small>Priority {connection.priority ?? 100} · {(connection.allowed_clients || []).join(', ') || 'OrbitFS Engine'}</small></div>
						<span class:selected={connection.base_url===data.connection?.providerBase}>{connection.base_url===data.connection?.providerBase?'Selected':'Available'}</span>
					</div>
				{/each}
			</div>
		</section>

		<section>
			<h2>Connection boundary</h2>
			<dl><dt>Official authority</dt><dd>License Manager runtime API only.</dd><dt>Panel URL</dt><dd>Installation-specific; remains under Host Configuration.</dd><dt>Engine Host URL</dt><dd>Installation-specific; never becomes a technical authority endpoint.</dd><dt>Customer Supabase / Vercel</dt><dd>Deployment/runtime infrastructure; not selectable here.</dd></dl>
		</section>
	</main>
</div>

<style>
	.shell{min-height:100vh}header{height:54px;border-bottom:1px solid #25282d;display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:#0b0d10}header>a{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:9px;font-size:10px;color:#777}nav a{color:#aaa;text-decoration:none}main{max-width:1000px;margin:0 auto;padding:34px 18px 60px}.title{display:flex;justify-content:space-between;align-items:end;gap:16px;border-bottom:1px solid #25282d;padding-bottom:18px}.title small{font-size:9px;color:#777;letter-spacing:.14em}.title h1{font-size:28px;margin:4px 0}.title p{margin:0;color:#858b92;font-size:12px}.title>span{border:1px solid #353a40;padding:7px 9px;font-size:9px;text-transform:uppercase}section{border:1px solid #25282d;background:#0c0f12;padding:16px;margin-top:14px}section h2{font-size:15px;margin:0}.section-title{display:flex;justify-content:space-between;gap:12px}.section-title p{font-size:9px;color:#777;margin:4px 0 0}.section-title>span{font-size:8px;color:#777}.form-grid{display:grid;gap:10px;margin-top:14px}.form-grid label{display:grid;gap:6px}.form-grid label span{font-size:9px;color:#777;text-transform:uppercase}.form-grid input{width:100%;padding:9px 10px;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}.buttons{display:flex;flex-wrap:wrap;gap:7px}.buttons button{padding:8px 10px;font-size:9px}.help{font-size:9px;color:#777;line-height:1.6}.notice{margin-top:10px;padding:9px 10px;border:1px solid #333;font-size:9px}.notice.ok{border-color:#28583d;color:#75c99d;background:#0b120e}.notice.error{border-color:#662a2a;color:#e6a7a7;background:#140909}.connection-list{display:grid;gap:7px;margin-top:12px}.connection{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #23262b;padding:10px 2px}.connection:first-child{border-top:0}.connection div{min-width:0;display:grid;gap:3px}.connection b{font-size:10px}.connection code{font-size:9px;word-break:break-all}.connection small{font-size:8px;color:#70767d}.connection>span{border:1px solid #353a40;padding:5px 7px;font-size:8px}.connection>span.selected{border-color:#28583d;color:#75c99d;background:#0b120e}dl{display:grid;grid-template-columns:170px 1fr;gap:8px 12px;font-size:10px;margin:12px 0 0}dt{color:#747a81}dd{margin:0;word-break:break-word}@media(max-width:700px){nav{display:none}.title{align-items:start;flex-direction:column}dl{grid-template-columns:1fr}.connection{align-items:start;flex-direction:column}}
</style>
