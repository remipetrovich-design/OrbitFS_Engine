<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();
	let engine = $derived(data.engine);
	let setupComplete = $derived(engine.setupState === 'complete');
	let setupLabel = $derived(String(engine.setupState || 'not_started').replaceAll('_', ' '));
	let runtimeDescription = $derived(engine.id === 'mcp' ? 'Running, Restart or Stop. MCP has no Standby mode.' : 'Run, Standby, Restart or Stop.');
	let monitoringLabel = $derived(engine.id === 'apex' ? 'Queue & activity' : engine.id === 'mcp' ? 'MCP activity' : 'Monitoring');
	let monitoringDescription = $derived(engine.id === 'apex' ? 'Queue, sorting/routing, conversions, users and failures.' : engine.id === 'mcp' ? 'Users, ChatGPT/MCP tool actions, sessions and targets.' : 'Current state and readiness metrics.');
	let refreshing = $state(false);
	let refreshedAt = $state<Date | null>(null);
	let items = $derived([
		...(!setupComplete ? [['First-time setup', `/engines/${engine.id}/setup`, 'Complete required setup and readiness checks.']] : []),
		['Configuration', `/engines/${engine.id}/configuration`, 'Edit settings used by this Engine runtime.'],
		['Connections', `/engines/${engine.id}/connections`, engine.id === 'mcp' ? 'Manage MCP clients and sessions.' : 'View Engine connections.'],
		...(engine.id === 'mcp' ? [['OAuth', `/engines/${engine.id}/oauth`, 'Registered clients, tokens and revocation.']] : []),
		['Runtime', `/engines/${engine.id}/runtime`, runtimeDescription],
		[monitoringLabel, `/engines/${engine.id}/monitoring`, monitoringDescription],
		['Logs', `/engines/${engine.id}/logs`, 'Recent Engine activity.'],
		['Diagnostics', `/engines/${engine.id}/diagnostics`, 'Readiness and deployment checks.']
	]);

	async function refreshPanel() {
		if (refreshing) return;
		refreshing = true;
		try {
			await invalidateAll();
			refreshedAt = new Date();
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head><title>{engine.name} · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="shell">
	<header><a class="brand" href="/engines">OrbitFS Engine Host</a><nav><a href="/engines">← Engines</a>{#if engine.panelUrl}<a href={engine.panelUrl}>Panel</a>{/if}</nav></header>
	<main>
		<div class="toolbar"><div>{#if refreshedAt}<span>Updated {refreshedAt.toLocaleTimeString()}</span>{/if}</div><button type="button" onclick={refreshPanel} disabled={refreshing}>{refreshing ? 'Refreshing…' : '↻ Refresh Engine'}</button></div>
		<div class="hero"><div><small>{engine.id.toUpperCase()}</small><h1>{engine.fullName}</h1><p>{engine.description}</p></div><span>{engine.engineState}</span></div>
		{#if form?.error}<div class="notice error">{form.error}</div>{/if}
		{#if !engine.linked}<div class="notice error">Engine is not linked to the Panel. Attach it from Panel first.</div>{/if}
		{#if !engine.licensed}<div class="notice error">Licence component {engine.component} is not available.</div>{/if}

		<div class="facts">
			<span><small>Installed</small><b>{engine.installed ? 'Yes' : 'No'}</b></span>
			<span><small>Attached</small><b>{engine.attached ? 'Yes' : 'No'}</b></span>
			<span><small>Setup</small><b>{setupLabel}</b></span>
			<span><small>Runtime</small><b>{engine.engineState}</b></span>
			<span><small>Workspace</small><b>{engine.workspaceName || engine.workspaceId || 'Not assigned'}</b></span>
		</div>

		{#if setupComplete}
			<div class="setup-complete"><div><b>Setup complete</b><span>This Engine is configured and ready for normal management.</span></div><a href={`/engines/${engine.id}/setup`}>Run setup again</a></div>
		{/if}

		<section>
			<div class="section-title"><h2>Manage</h2><span>{items.length} tools</span></div>
			<div class="cards">{#each items as item}<a href={item[1]}><div><b>{item[0]}</b><span>{item[2]}</span></div><em>Open →</em></a>{/each}</div>
		</section>

		<section>
			<h2>Backend</h2>
			<dl><dt>Engine Host</dt><dd>{engine.hostUrl || 'Not linked'}</dd><dt>Panel</dt><dd>{engine.panelUrl || 'Not linked'}</dd><dt>Workspace</dt><dd>{engine.workspaceName || engine.workspaceId || 'Not assigned'}</dd><dt>Storage</dt><dd>Shared Supabase</dd>{#if engine.transportPath}<dt>Transport</dt><dd>{engine.hostUrl ? `${String(engine.hostUrl).replace(/\/$/, '')}${engine.transportPath}` : engine.transportPath}</dd>{/if}<dt>Last sync</dt><dd>{engine.lastSyncAt || 'Never'}</dd></dl>
		</section>
	</main>
</div>

<style>
	:global(html){background:#090b0e;color:#eee;font-family:Inter,ui-sans-serif,system-ui}:global(body){margin:0;background:#090b0e}.shell{min-height:100vh}header{min-height:56px;border-bottom:1px solid #24282e;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 22px;background:#0b0d10;position:sticky;top:0;z-index:20}.brand{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:10px;font-size:10px}nav a{color:#b5bac1;text-decoration:none}main{max-width:1080px;margin:0 auto;padding:22px 18px 64px}.toolbar{display:flex;justify-content:flex-end;align-items:center;gap:9px;margin-bottom:10px}.toolbar div{flex:1}.toolbar span{font-size:8px;color:#6f767e}.toolbar button{border:1px solid #343a42;background:#101419;color:#cbd1d8;border-radius:6px;padding:7px 10px;font-size:9px;cursor:pointer}.toolbar button:disabled{opacity:.5}.hero{display:flex;justify-content:space-between;align-items:end;gap:18px;border-bottom:1px solid #252a30;padding-bottom:18px}.hero small{font-size:9px;color:#7c838b;letter-spacing:.15em}.hero h1{font-size:30px;margin:4px 0 5px}.hero p{margin:0;color:#899099;font-size:12px}.hero>span{border:1px solid #3c4249;padding:7px 10px;border-radius:999px;font-size:9px;text-transform:capitalize}.notice{padding:11px 13px;border:1px solid #343a42;margin:14px 0;border-radius:7px;font-size:11px}.notice.error{border-color:#6d3131;color:#f2b6b6;background:#160d0d}.facts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid #252a30;border-radius:8px;overflow:hidden;margin:16px 0}.facts span{padding:10px;border-right:1px solid #252a30;min-width:0}.facts span:last-child{border-right:0}.facts small{display:block;color:#737a82;font-size:8px;text-transform:uppercase}.facts b{display:block;margin-top:3px;font-size:10px;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.setup-complete{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #2c6042;background:#0d1711;border-radius:8px;padding:11px 13px;margin-bottom:14px}.setup-complete div{display:grid;gap:2px}.setup-complete b{font-size:10px;color:#9de0b8}.setup-complete span{font-size:9px;color:#7e9788}.setup-complete a{color:#c6d8cc;text-decoration:none;border:1px solid #355e45;padding:7px 9px;border-radius:6px;font-size:9px}section{border:1px solid #252a30;background:#0d1014;border-radius:9px;padding:17px;margin-top:14px}section h2{font-size:15px;margin:0 0 12px}.section-title{display:flex;justify-content:space-between;align-items:center;gap:10px}.section-title span{font-size:8px;color:#727981}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.cards a{display:flex;justify-content:space-between;gap:14px;border:1px solid #292e34;background:#101419;border-radius:8px;padding:12px;color:#ddd;text-decoration:none;min-width:0}.cards a:hover{border-color:#444b54}.cards div{display:grid;gap:3px;min-width:0}.cards b{font-size:11px}.cards span{font-size:9px;color:#7d858e;line-height:1.45}.cards em{font-style:normal;color:#9ea5ad;font-size:8px;white-space:nowrap}dl{display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px 12px;font-size:10px;margin:0}dt{color:#747b83}dd{margin:0;word-break:break-all}
	@media(max-width:760px){header{padding:0 14px}main{padding:16px 12px 50px}.toolbar{position:sticky;top:62px;z-index:10;background:#090b0e;padding:5px 0}.hero{align-items:flex-start;flex-direction:column}.hero h1{font-size:25px}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}.facts span{border-bottom:1px solid #252a30}.facts span:nth-child(even){border-right:0}.facts span:last-child{grid-column:1/-1;border-bottom:0}.cards{grid-template-columns:1fr}.setup-complete{align-items:flex-start;flex-direction:column}.setup-complete a{width:100%;box-sizing:border-box;text-align:center}dl{grid-template-columns:1fr;gap:3px 0}dd{margin-bottom:8px}}
</style>