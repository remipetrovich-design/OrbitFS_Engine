<script lang="ts">
	let { data } = $props();
	const linkedCount=data.engines.filter((engine:any)=>engine.linked).length;
	const setupCount=data.engines.filter((engine:any)=>engine.setupState==='complete').length;
</script>

<svelte:head><title>Host Configuration · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="shell">
	<header><a href="/engines">OrbitFS Engine Host</a><nav><a href="/engines">Engines</a><b>Host configuration</b><a href="/configuration/api-connections">API connections</a><a href={data.services.panelUrl}>Panel</a></nav></header>
	<main>
		<div class="title"><div><small>HOST CONFIGURATION</small><h1>Engine Host</h1><p>Deployment, pairing and backend facts for this OrbitFS installation.</p></div><span>{data.host?.state?.replaceAll('_',' ') || 'not linked'}</span></div>

		<div class="facts"><span><small>Installation</small><b>{data.installationId}</b></span><span><small>Workspace</small><b>{data.mainWorkspace?.name || 'None'}</b></span><span><small>Engines linked</small><b>{linkedCount}/{data.engines.length}</b></span><span><small>Setup complete</small><b>{setupCount}/{data.engines.length}</b></span></div>

		<section><h2>Deployment</h2><dl><dt>Environment</dt><dd>{data.deployment.environment}</dd><dt>Git branch</dt><dd>{data.deployment.branch || 'Not reported'}</dd><dt>Current URL</dt><dd>{data.deployment.currentOrigin}</dd><dt>Engine Host URL</dt><dd>{data.services.engineHostUrl}</dd><dt>Vercel project ID</dt><dd>{data.host?.projectId || 'Not reported'}</dd><dt>Vercel project name</dt><dd>{data.host?.projectName || 'Not reported'}</dd><dt>Panel URL</dt><dd>{data.services.panelUrl}</dd><dt>MCP transport</dt><dd>{data.services.mcpUrl}</dd></dl><p class="updater-note">Use the Engine Host URL and Vercel project ID on <b>My OrbitFS → Configuration → Updater connection</b>. Linking the Updater does not run the Inner Deployer.</p></section>

		<section><h2>Backend</h2><dl><dt>Compute</dt><dd>{data.backend.compute}</dd><dt>Database</dt><dd>{data.backend.database}</dd><dt>Storage</dt><dd>{data.backend.storage}</dd><dt>Filesystem model</dt><dd>{data.backend.filesystem}</dd><dt>Supabase configured</dt><dd>{data.backend.supabaseConfigured ? 'Yes' : 'No'}</dd><dt>Panel pairing</dt><dd>{data.backend.pairingRegistryConfigured ? 'Linked' : 'Not linked'}</dd></dl></section>

		<section><div class="section-title"><h2>Licence</h2><span><a href="/configuration/api-connections">Manage API connection →</a></span></div><dl><dt>Status</dt><dd>{data.license.status || 'unknown'}</dd><dt>Plan</dt><dd>{data.license.plan || '—'}</dd><dt>Licensed to</dt><dd>{data.license.licensedTo || '—'}</dd><dt>Expires</dt><dd>{data.license.expiresAt || '—'}</dd><dt>Provider</dt><dd>{data.services.licenseProvider}</dd></dl></section>

		<section>
			<div class="section-title"><h2>Engines</h2><span>Engine-specific settings are edited inside each Engine.</span></div>
			<div class="table"><div class="row head"><span>Engine</span><span>Attached</span><span>Setup</span><span>Runtime</span><span></span></div>{#each data.engines as engine}<div class="row"><span><b>{engine.fullName}</b><small>{engine.description}</small></span><span>{engine.attached ? 'Yes' : 'No'}</span><span>{String(engine.setupState||'not_started').replaceAll('_',' ')}</span><span>{engine.engineState}</span><span><a href={`/engines/${engine.id}/configuration`}>Configure</a></span></div>{/each}</div>
		</section>
	</main>
</div>

<style>
	.shell{min-height:100vh}header{height:54px;border-bottom:1px solid #25282d;display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:#0b0d10}header>a{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:9px;font-size:10px;color:#777}nav a{color:#aaa;text-decoration:none}main{max-width:1000px;margin:0 auto;padding:34px 18px 60px}.title{display:flex;justify-content:space-between;align-items:end;gap:16px;border-bottom:1px solid #25282d;padding-bottom:18px}.title small{font-size:9px;color:#777;letter-spacing:.14em}.title h1{font-size:28px;margin:4px 0}.title p{margin:0;color:#858b92;font-size:12px}.title>span{border:1px solid #353a40;padding:7px 9px;font-size:9px;text-transform:capitalize}.facts{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #25282d;margin:18px 0}.facts span{padding:10px;border-right:1px solid #25282d;min-width:0}.facts span:last-child{border-right:0}.facts small{display:block;color:#737980;font-size:8px;text-transform:uppercase}.facts b{display:block;margin-top:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}section{border:1px solid #25282d;background:#0c0f12;padding:16px;margin-top:14px}section h2{font-size:15px;margin:0}.section-title{display:flex;justify-content:space-between;gap:12px}.section-title span{font-size:8px;color:#777}dl{display:grid;grid-template-columns:160px 1fr;gap:8px 12px;font-size:10px;margin:12px 0 0}dt{color:#747a81}dd{margin:0;word-break:break-all}.table{overflow:auto;margin-top:12px}.row{min-width:720px;display:grid;grid-template-columns:2fr .7fr .9fr .8fr .7fr;gap:10px;align-items:center;padding:9px 5px;border-top:1px solid #23262b;font-size:9px}.row.head{border-top:0;text-transform:uppercase;color:#777;font-size:8px}.row span:first-child{display:grid}.row b{font-size:10px}.row small{font-size:8px;color:#70767d;margin-top:2px}.row a{color:#ddd;text-decoration:none;border:1px solid #333;padding:6px 8px}@media(max-width:700px){.facts{grid-template-columns:1fr}.facts span{border-right:0;border-bottom:1px solid #25282d}.facts span:last-child{border-bottom:0}.title{align-items:start;flex-direction:column}dl{grid-template-columns:1fr}}
.updater-note{margin:12px 0 0;color:#8a9097;font-size:9px;line-height:1.5}.updater-note b{color:#ddd}</style>
