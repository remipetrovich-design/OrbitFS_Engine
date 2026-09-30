<script lang="ts">
	let { data } = $props();
	const engine = data.engine;
	const engineState: any = engine.state;
</script>

<svelte:head><title>{engine.name} Diagnostics · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="shell">
	<header><a href="/engines">OrbitFS Engine Host</a><nav><a href={`/engines/${engine.id}`}>{engine.name}</a><b>Diagnostics</b></nav></header>
	<main>
		<div class="title"><div><small>DIAGNOSTICS</small><h1>{engine.fullName}</h1><p>Read-only pairing, deployment and readiness information.</p></div><span>{data.ready ? 'Ready' : 'Attention required'}</span></div>

		<div class="facts"><span><small>Panel link</small><b>{engine.linked ? 'Connected' : 'Not linked'}</b></span><span><small>Setup</small><b>{engine.setupState.replaceAll('_',' ')}</b></span><span><small>Runtime</small><b>{engine.engineState}</b></span><span><small>Checks</small><b>{data.checks.filter((c:any)=>c.ok).length}/{data.checks.length}</b></span></div>

		<section>
			<h2>Readiness checks</h2>
			<div class="checks">{#each data.checks as check}<div class:ok={check.ok}><span>{check.ok ? 'PASS' : check.required ? 'BLOCK' : 'INFO'}</span><div><b>{check.label}</b><small>{check.description}</small></div></div>{/each}</div>
		</section>

		<section>
			<h2>Backend details</h2>
			<dl><dt>Panel</dt><dd>{engine.panelUrl || 'Not linked'}</dd><dt>Engine Host</dt><dd>{engine.hostUrl || 'Not linked'}</dd><dt>Installation</dt><dd>{engineState?.installationId || (engine as any).installationId || 'Current installation'}</dd><dt>Workspace</dt><dd>{engine.workspaceName || engine.workspaceId || 'Not assigned'}</dd><dt>Setup version</dt><dd>{engine.setupVersion}</dd><dt>Deployment</dt><dd>{engine.state?.deployment || 'ready'}</dd><dt>Compute</dt><dd>{engine.state?.compute || 'vercel'}</dd><dt>Database</dt><dd>{engine.state?.database || 'supabase'}</dd><dt>Last Panel sync</dt><dd>{engine.lastSyncAt ? new Date(engine.lastSyncAt).toLocaleString() : 'Never'}</dd>{#if engine.transportPath}<dt>Transport</dt><dd>{engine.transportPath}</dd>{/if}</dl>
		</section>

		<div class="links"><a href={`/engines/${engine.id}/setup`}>Setup</a><a href={`/engines/${engine.id}/configuration`}>Configuration</a><a href={`/engines/${engine.id}/connections`}>Connections</a><a href={`/engines/${engine.id}/runtime`}>Runtime</a></div>
	</main>
</div>

<style>
	.shell{min-height:100vh}header{height:54px;border-bottom:1px solid #25282d;display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:#0b0d10}header>a{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:8px;font-size:10px;color:#777}nav a{color:#aaa;text-decoration:none}main{max-width:920px;margin:0 auto;padding:34px 18px 60px}.title{display:flex;justify-content:space-between;align-items:end;gap:16px;border-bottom:1px solid #25282d;padding-bottom:18px}.title small{font-size:9px;color:#777;letter-spacing:.14em}.title h1{font-size:28px;margin:4px 0}.title p{margin:0;color:#858b92;font-size:12px}.title>span{border:1px solid #353a40;padding:7px 9px;font-size:9px}.facts{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #25282d;margin:18px 0}.facts span{padding:10px;border-right:1px solid #25282d;min-width:0}.facts span:last-child{border-right:0}.facts small{display:block;color:#737980;font-size:8px;text-transform:uppercase}.facts b{display:block;margin-top:3px;font-size:10px;text-transform:capitalize}section{border:1px solid #25282d;background:#0c0f12;padding:16px;margin-top:14px}section h2{font-size:15px;margin:0}.checks{display:grid;margin-top:10px}.checks>div{display:grid;grid-template-columns:55px 1fr;gap:10px;padding:9px 0;border-top:1px solid #23262b}.checks>div:first-child{border-top:0}.checks>div>span{font-size:8px;color:#d19e68}.checks>div.ok>span{color:#73cf97}.checks b{font-size:10px}.checks small{display:block;color:#747a81;font-size:9px;margin-top:2px}dl{display:grid;grid-template-columns:150px 1fr;gap:8px 12px;font-size:10px;margin:12px 0 0}dt{color:#747a81}dd{margin:0;word-break:break-all}.links{display:flex;gap:7px;flex-wrap:wrap;margin-top:16px}.links a{border:1px solid #30343a;color:#aaa;text-decoration:none;padding:7px 9px;font-size:9px}@media(max-width:700px){.facts{grid-template-columns:1fr}.facts span{border-right:0;border-bottom:1px solid #25282d}.facts span:last-child{border-bottom:0}.title{align-items:start;flex-direction:column}dl{grid-template-columns:1fr}}
</style>
