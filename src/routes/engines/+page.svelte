<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();
	let hostReady = $derived(['linked','ready'].includes(String(data.host?.state || '')));
	let refreshing = $state(false);
	let refreshedAt = $state<Date | null>(null);
	const statusLabel=(engine:any)=>{if(!engine.licensed)return'Licence required';if(!hostReady)return'Host not linked';if(!engine.registered||!engine.installed)return'Not installed';if(!engine.attached)return'Detached';if(engine.setupState!=='complete')return'Setup required';return engine.engineState==='running'?'Running':engine.engineState==='stopped'?'Stopped':'Standby';};

	async function refreshPanel(){
		if(refreshing)return;
		refreshing=true;
		try{await invalidateAll();refreshedAt=new Date();}
		finally{refreshing=false;}
	}
</script>

<svelte:head><title>Engines · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="shell">
	<header><a class="brand" href="/engines">OrbitFS Engine Host</a><div class="right">{#if data.canManage}<a href="/configuration">Host configuration</a>{/if}<span>{data.user.display_name||data.user.username}</span><form method="POST" action="?/logout"><button>Sign out</button></form></div></header>
	<main>
		<div class="toolbar"><div>{#if refreshedAt}<span>Updated {refreshedAt.toLocaleTimeString()}</span>{/if}</div><button type="button" onclick={refreshPanel} disabled={refreshing}>{refreshing?'Refreshing…':'↻ Refresh panel'}</button></div>
		<div class="hero"><div><small>ENGINE HOST</small><h1>Engines</h1><p>Configure and run the Engine add-ons linked to this OrbitFS installation.</p></div><div class="host"><span>Shared host</span><b>{String(data.host?.state||'not linked').replaceAll('_',' ')}</b><small>{data.host?.panelUrl||'No Panel linked'}</small></div></div>
		{#if !hostReady}<div class="notice">This Engine Host is not linked to an OrbitFS Panel yet.</div>{/if}

		<div class="engine-grid">
			{#each data.engines as engine}
				<article class:locked={!engine.licensed}>
					<div class="card-head"><div><small>{engine.id.toUpperCase()}</small><h2>{engine.fullName||engine.name}</h2><p>{engine.description}</p></div><span class:good={statusLabel(engine)==='Running'} class:warn={['Setup required','Detached','Host not linked'].includes(statusLabel(engine))}>{statusLabel(engine)}</span></div>
					<div class="stats"><span><small>Installed</small><b>{engine.registered&&engine.installed?'Yes':'No'}</b></span><span><small>Attached</small><b>{engine.attached?'Yes':'No'}</b></span><span><small>Setup</small><b>{engine.licensed?String(engine.setupState||'not_started').replaceAll('_',' '):'Locked'}</b></span><span><small>Runtime</small><b>{engine.licensed?engine.engineState:'Locked'}</b></span></div>
					<div class="card-foot">
						{#if hostReady&&engine.registered&&engine.licensed&&engine.attached}<a href={`/engines/${engine.id}`}>Manage Engine</a>{:else if !engine.licensed}<span>Licence required</span>{:else}<span>Panel action required</span>{/if}
					</div>
				</article>
			{/each}
		</div>
		<div class="meta"><span>Installation: {data.installationId}</span><span>Workspace: {data.mainWorkspace?.name||'None'}</span></div>
	</main>
</div>

<style>
	:global(html){background:#090b0e;color:#eee;font-family:Inter,ui-sans-serif,system-ui}:global(body){margin:0;background:#090b0e}.shell{min-height:100vh}header{min-height:56px;border-bottom:1px solid #24282e;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 22px;background:#0b0d10;position:sticky;top:0;z-index:20}.brand{color:#fff;text-decoration:none;font-weight:700;font-size:13px}.right{display:flex;gap:10px;align-items:center;color:#828991;font-size:9px}.right a{color:#c0c5ca;text-decoration:none}.right form{margin:0}.right button{border:1px solid #343a42;background:#11151a;color:#aaa;border-radius:6px;padding:7px 9px;font-size:8px}main{max-width:1120px;margin:0 auto;padding:22px 18px 64px}.toolbar{display:flex;justify-content:flex-end;align-items:center;gap:9px;margin-bottom:10px}.toolbar div{flex:1}.toolbar span{font-size:8px;color:#6f767e}.toolbar button{border:1px solid #343a42;background:#101419;color:#cbd1d8;border-radius:6px;padding:7px 10px;font-size:9px;cursor:pointer}.toolbar button:disabled{opacity:.5}.hero{display:flex;justify-content:space-between;align-items:end;gap:20px;border-bottom:1px solid #252a30;padding-bottom:18px}.hero small{font-size:9px;color:#7b828a;letter-spacing:.15em}.hero h1{font-size:30px;margin:4px 0 5px}.hero p{margin:0;color:#899099;font-size:12px}.host{text-align:right;min-width:220px}.host span,.host small{display:block;color:#737a82;font-size:8px}.host b{display:block;margin:3px 0;font-size:11px;text-transform:capitalize}.notice{border:1px solid #654f32;color:#dfc28f;background:#151008;padding:11px 13px;border-radius:7px;margin-top:14px;font-size:10px}.engine-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px}article{border:1px solid #252a30;background:#0d1014;border-radius:10px;padding:16px;min-width:0}article.locked{opacity:.7}.card-head{display:flex;justify-content:space-between;gap:14px}.card-head>div{min-width:0}.card-head small{font-size:8px;color:#737a82;letter-spacing:.14em}.card-head h2{font-size:16px;margin:4px 0}.card-head p{margin:0;color:#7f868f;font-size:9px;line-height:1.45}.card-head>span{height:max-content;border:1px solid #3b4148;border-radius:999px;padding:6px 8px;font-size:8px;white-space:nowrap}.card-head>span.good{border-color:#2d6846;color:#91deb0}.card-head>span.warn{border-color:#6a5334;color:#ddb77a}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid #252a30;border-radius:7px;overflow:hidden;margin:14px 0}.stats span{padding:9px;border-right:1px solid #252a30;min-width:0}.stats span:last-child{border-right:0}.stats small{display:block;color:#6f767e;font-size:7px;text-transform:uppercase}.stats b{display:block;margin-top:3px;font-size:9px;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card-foot{display:flex;justify-content:flex-end}.card-foot a{border:1px solid #3a4149;background:#15191e;color:#eee;text-decoration:none;padding:8px 10px;border-radius:6px;font-size:9px}.card-foot span{color:#747b83;font-size:8px}.meta{display:flex;gap:18px;flex-wrap:wrap;margin-top:13px;color:#686f77;font-size:8px}
	@media(max-width:760px){header{padding:0 14px}.right>span{display:none}main{padding:16px 12px 50px}.toolbar{position:sticky;top:62px;z-index:10;background:#090b0e;padding:5px 0}.hero{align-items:flex-start;flex-direction:column}.hero h1{font-size:25px}.host{text-align:left;min-width:0}.engine-grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stats span:nth-child(2){border-right:0}.stats span:nth-child(-n+2){border-bottom:1px solid #252a30}.card-foot a{width:100%;box-sizing:border-box;text-align:center}}
	@media(max-width:430px){.card-head{flex-direction:column}.card-head>span{align-self:flex-start}}
</style>