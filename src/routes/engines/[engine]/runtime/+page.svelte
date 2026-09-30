<script lang="ts">
	let { data, form } = $props();
	const engine = data.engine;
	const isMcp = engine.id === 'mcp';
	const standbyAllowed = data.standbyAllowed !== false;
</script>

<svelte:head><title>{engine.name} Runtime · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="shell">
	<header><a href="/engines">OrbitFS Engine Host</a><nav><a href={`/engines/${engine.id}`}>{engine.name}</a><b>Runtime</b></nav></header>
	<main>
		<div class="title"><div><small>RUNTIME</small><h1>{engine.fullName}</h1><p>{isMcp ? 'MCP is request-driven. It is either available to handle requests or administratively stopped.' : 'Control the Engine runtime state independently from first-time setup.'}</p></div><span class="state">{engine.engineState}</span></div>

		{#if form?.error}<div class="notice error">{form.error}</div>{/if}
		{#if form?.message}<div class="notice ok">{form.message}</div>{/if}
		{#if !engine.linked}<div class="notice error">Attach and link this Engine from Panel before changing runtime state.</div>{/if}

		<div class="facts">
			<span><small>State</small><b>{engine.engineState}</b></span>
			<span><small>Setup</small><b>{engine.setupState.replaceAll('_',' ')}</b></span>
			<span><small>Generation</small><b>{engine.state?.generation || 1}</b></span>
			<span><small>Last request</small><b>{engine.state?.lastRequestAt || 'None yet'}</b></span>
		</div>

		<section>
			<h2>Runtime controls</h2>
			{#if isMcp}
				<p class="muted">There is no MCP Standby mode. Vercel handles idle compute automatically; OrbitFS only needs an application-level Running or Stopped state.</p>
				<div class="modes two"><div class:active={engine.engineState === 'running'}><b>Running</b><span>MCP accepts authorised transport requests.</span></div><div class:active={engine.engineState === 'stopped'}><b>Stopped</b><span>Administrative hard stop. MCP requests are rejected until started again.</span></div></div>
			{:else}
				{#if !standbyAllowed}<p class="muted">Standby is disabled in this Engine's configuration. APEX stays Running until explicitly Stopped.</p>{/if}
				<div class:two={!standbyAllowed} class="modes"><div class:active={engine.engineState === 'running'}><b>Running</b><span>Accept normal work and requests.</span></div>{#if standbyAllowed}<div class:active={engine.engineState === 'standby'}><b>Standby</b><span>Available for on-demand work without pretending a resident process is running.</span></div>{/if}<div class:active={engine.engineState === 'stopped'}><b>Stopped</b><span>Administrative hard stop until an administrator starts it again.</span></div></div>
			{/if}

			{#if data.canManage}
				<div class="actions">
					<form method="POST" action="?/control"><input type="hidden" name="action" value="running"/><button class="primary">Run</button></form>
					{#if !isMcp && standbyAllowed}<form method="POST" action="?/control"><input type="hidden" name="action" value="standby"/><button>Standby</button></form>{/if}
					<form method="POST" action="?/control"><input type="hidden" name="action" value="restart"/><button>Restart</button></form>
					<form method="POST" action="?/control"><input type="hidden" name="action" value="stopped"/><button class="danger">Stop</button></form>
				</div>
			{:else if data.canWake}
				<div class="wake"><span>This Engine is in Standby and your workspace permission allows you to wake it.</span><form method="POST" action="?/control"><input type="hidden" name="action" value="running"/><button class="primary">Wake {engine.name}</button></form></div>
			{/if}
		</section>

		<section>
			<h2>Backend</h2>
			<dl><dt>Compute</dt><dd>{engine.state?.compute || 'vercel'}</dd><dt>Database</dt><dd>{engine.state?.database || 'supabase'}</dd><dt>Deployment</dt><dd>{engine.state?.deployment || 'ready'}</dd><dt>Workspace</dt><dd>{engine.workspaceName || engine.workspaceId || 'Not linked'}</dd>{#if engine.transportPath}<dt>Transport</dt><dd>{engine.transportPath}</dd>{/if}<dt>Last control</dt><dd>{engine.state?.lastControlAt || 'Never'}</dd></dl>
		</section>
	</main>
</div>

<style>
	.shell{min-height:100vh}header{height:54px;border-bottom:1px solid #25282d;display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:#0b0d10}header>a{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:8px;font-size:10px;color:#777}nav a{color:#aaa;text-decoration:none}main{max-width:920px;margin:0 auto;padding:34px 18px 60px}.title{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid #25282d;padding-bottom:18px;gap:16px}.title small{font-size:9px;color:#777;letter-spacing:.14em}.title h1{font-size:28px;margin:4px 0}.title p{margin:0;color:#858b92;font-size:12px;max-width:700px}.state{border:1px solid #363b41;padding:7px 9px;font-size:10px;text-transform:capitalize}.notice{padding:10px 12px;border:1px solid #343940;margin:14px 0;font-size:11px}.notice.error{border-color:#6a3030;color:#f3b4b4}.notice.ok{border-color:#2f6646;color:#9de2b8}.facts{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #25282d;margin:18px 0}.facts span{padding:10px;border-right:1px solid #25282d;min-width:0}.facts span:last-child{border-right:0}.facts small{display:block;color:#737980;font-size:8px;text-transform:uppercase}.facts b{display:block;margin-top:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:capitalize}section{border:1px solid #25282d;background:#0c0f12;margin-top:14px;padding:16px}section h2{font-size:15px;margin:0 0 10px}.muted{font-size:10px;color:#858b93}.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.modes.two{grid-template-columns:repeat(2,1fr)}.modes>div{border:1px solid #2b2f35;padding:12px}.modes>div.active{border-color:#666}.modes b{font-size:11px}.modes span{display:block;color:#777;font-size:9px;line-height:1.45;margin-top:4px}.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:14px}.actions form{margin:0}button{border:1px solid #353940;background:#111;color:#ddd;padding:8px 11px;font-size:10px;font-weight:700;cursor:pointer}button.primary{background:#eee;color:#090b0e;border-color:#eee}button.danger{border-color:#6a3030;color:#f3b4b4;background:#160b0b}.wake{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #25282d;margin-top:14px;padding-top:12px}.wake span{font-size:10px;color:#858b93}dl{display:grid;grid-template-columns:130px 1fr;gap:8px 12px;font-size:10px;margin:0}dt{color:#747a81}dd{margin:0;word-break:break-all}@media(max-width:700px){.facts,.modes,.modes.two{grid-template-columns:1fr}.facts span{border-right:0;border-bottom:1px solid #25282d}.facts span:last-child{border-bottom:0}.title{align-items:start;flex-direction:column}.wake{align-items:stretch;flex-direction:column}dl{grid-template-columns:1fr}}
</style>
