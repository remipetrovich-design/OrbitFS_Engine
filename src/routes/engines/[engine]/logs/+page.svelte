<script lang="ts">
	let { data } = $props();
	const engine=data.engine;
	const fmt=(value:any)=>value?new Date(value).toLocaleString():'Unknown';
	const humanize=(value:any)=>String(value||'event').replace(/^engine\./,'').replace(/[._-]+/g,' ').replace(/\b\w/g,(m)=>m.toUpperCase());
	const detailEntries=(value:any)=>value && typeof value==='object' && !Array.isArray(value) ? Object.entries(value) : [];
	const displayValue=(value:any)=>{
		if(value===null||value===undefined||value==='') return '—';
		if(typeof value==='object') { try{return JSON.stringify(value)}catch{return '[details]'} }
		return String(value);
	};
</script>

<svelte:head><title>{engine.name} Logs · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="shell">
	<header><a href="/engines">OrbitFS Engine Host</a><nav><a href={`/engines/${engine.id}`}>{engine.name}</a><b>Logs</b></nav></header>
	<main>
		<div class="title"><div><small>ACTIVITY LOG</small><h1>{engine.fullName}</h1><p>Recent Engine activity from the shared OrbitFS audit trail.</p></div><a href={`/engines/${engine.id}`}>Back to engine</a></div>

		<div class="facts"><span><small>Entries</small><b>{data.logs.length}</b></span><span><small>Source</small><b>{engine.id==='mcp'?'MCP audit':'OrbitFS audit'}</b></span><span><small>Storage</small><b>Supabase</b></span><span><small>Runtime</small><b>{engine.engineState}</b></span></div>

		<section>
			<div class="section-title"><h2>Recent activity</h2><span>Newest first · maximum 200</span></div>
			{#if data.logs.length}
				<div class="logs">{#each data.logs as row}<article><div class="event"><div><b>{humanize(row.type)}</b><small>{fmt(row.createdAt)}</small></div><code>{row.type || 'event'}</code></div><dl><dt>Workspace</dt><dd>{row.scopeName || 'Global'}{#if row.scope}<small>{row.scope}</small>{/if}</dd><dt>Actor</dt><dd>{row.actorName || 'System'}{#if row.actor}<small>{row.actor}</small>{/if}</dd></dl>{#if detailEntries(row.detail).length}<details><summary>Technical details ({detailEntries(row.detail).length})</summary><div class="details">{#each detailEntries(row.detail) as [key,value]}<div><span>{humanize(key)}</span><code>{displayValue(value)}</code></div>{/each}</div></details>{/if}</article>{/each}</div>
			{:else}<p class="empty">No recorded Engine events yet.</p>{/if}
		</section>

		<div class="links"><a href={`/engines/${engine.id}/monitoring`}>Monitoring</a><a href={`/engines/${engine.id}/diagnostics`}>Diagnostics</a></div>
	</main>
</div>

<style>
	.shell{min-height:100vh}header{height:54px;border-bottom:1px solid #25282d;display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:#0b0d10}header>a{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:8px;font-size:10px;color:#777}nav a{color:#aaa;text-decoration:none}main{max-width:980px;margin:0 auto;padding:34px 18px 60px}.title{display:flex;justify-content:space-between;align-items:end;gap:16px;border-bottom:1px solid #25282d;padding-bottom:18px}.title small{font-size:9px;color:#777;letter-spacing:.14em}.title h1{font-size:28px;margin:4px 0}.title p{margin:0;color:#858b92;font-size:12px}.title>a{color:#aaa;text-decoration:none;font-size:10px}.facts{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #25282d;margin:18px 0}.facts span{padding:10px;border-right:1px solid #25282d;min-width:0}.facts span:last-child{border-right:0}.facts small{display:block;color:#737980;font-size:8px;text-transform:uppercase}.facts b{display:block;margin-top:3px;font-size:10px;text-transform:capitalize}section{border:1px solid #25282d;background:#0c0f12;padding:16px;margin-top:14px}.section-title{display:flex;justify-content:space-between;gap:12px;align-items:center}.section-title h2{font-size:15px;margin:0}.section-title span{font-size:8px;color:#777}.logs{display:grid}.logs article{padding:13px 0;border-top:1px solid #23262b}.logs article:first-child{border-top:0}.event{display:flex;justify-content:space-between;gap:12px}.event>div{display:grid;gap:2px}.event b{font-size:10px}.event small{font-size:8px;color:#777}.event>code{font-size:8px;color:#8a8a8a}.logs dl{display:grid;grid-template-columns:90px 1fr;gap:6px 10px;font-size:9px;margin:9px 0}.logs dt{color:#747a81}.logs dd{margin:0;display:grid;gap:2px}.logs dd small{color:#666;font-size:8px;word-break:break-all}details{border:1px solid #292d32;margin-top:8px}summary{cursor:pointer;padding:8px 9px;font-size:8px;color:#aaa}.details{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid #292d32}.details>div{padding:8px;border-right:1px solid #292d32;border-bottom:1px solid #292d32;min-width:0}.details span{display:block;font-size:8px;color:#777}.details code{display:block;margin-top:3px;font-size:8px;white-space:pre-wrap;word-break:break-word}.empty{font-size:10px;color:#777}.links{display:flex;gap:7px;flex-wrap:wrap;margin-top:16px}.links a{border:1px solid #30343a;color:#aaa;text-decoration:none;padding:7px 9px;font-size:9px}@media(max-width:700px){.facts,.details{grid-template-columns:1fr}.facts span{border-right:0;border-bottom:1px solid #25282d}.facts span:last-child{border-bottom:0}.title{align-items:start;flex-direction:column}.event{flex-direction:column}.logs dl{grid-template-columns:1fr}}
</style>
