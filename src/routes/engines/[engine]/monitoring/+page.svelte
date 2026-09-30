<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();
	let engine = $derived(data.engine);
	let m = $derived(data.metrics);
	let activity = $derived(data.activity || []);
	let sessions = $derived(data.sessions || []);
	let refreshing = $state(false);
	let refreshedAt = $state<Date | null>(null);
	let cards = $derived(engine.id === 'mcp'
		? [
			['Active clients', m.activeClients || 0, `${m.clients || 0} registered`],
			['Active sessions', m.activeSessions || 0, `${m.totalRequests || 0} recent session requests`],
			['OAuth tokens', m.oauthActive || 0, 'currently valid access tokens'],
			['Activity 24h', m.auditEvents24h || 0, 'audited MCP actions']
		]
		: engine.id === 'apex'
		? [
			['Queued', m.queue || 0, 'waiting for processing'],
			['Processing', m.processing || 0, 'extracting / sorting / converting'],
			['Needs review', m.awaitingReview || 0, 'waiting on Panel review'],
			['Failed', m.failed || 0, `${m.completed || 0} completed recently`]
		]
		: [
			['Runtime', m.engineState, 'current engine mode'],
			['Setup', m.setupState, 'setup state'],
			['Generation', m.generation, 'runtime generation'],
			['Readiness', data.readiness.ready ? 'Ready' : 'Blocked', data.readiness.ready ? 'all checks pass' : `${data.readiness.blocking.length} blocking checks`]
		]);

	const fmt=(value:any)=>value ? new Date(value).toLocaleString() : 'None yet';
	const human=(value:any)=>String(value||'').replaceAll('_',' ').replaceAll('.',' ');
	const targetText=(target:any)=>{
		if(!target||typeof target!=='object')return '';
		return target.path||target.sourcePath||target.targetPath||target.fileName||target.name||target.itemId||target.sourceId||target.recordId||target.profileId||target.projectId||target.bundleId||'';
	};

	async function refreshPanel(){
		if(refreshing)return;
		refreshing=true;
		try{await invalidateAll();refreshedAt=new Date();}finally{refreshing=false;}
	}
</script>

<svelte:head><title>{engine.name} Monitoring · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="shell">
	<header><a class="brand" href="/engines">OrbitFS Engine Host</a><nav><a href={`/engines/${engine.id}`}>← {engine.name}</a><span>Monitoring</span></nav></header>
	<main>
		<div class="toolbar"><a href={`/engines/${engine.id}`}>← Back to {engine.name}</a><button onclick={refreshPanel} disabled={refreshing}>{refreshing?'Refreshing…':'↻ Refresh'}</button></div>
		<div class="hero"><div><small>{engine.id==='apex'?'QUEUE & ACTIVITY':engine.id==='mcp'?'MCP ACTIVITY':'MONITORING'}</small><h1>{engine.fullName}</h1><p>{engine.id==='apex'?'Live APEX job queue, document processing, sorting/routing and conversion activity.':engine.id==='mcp'?'Who is using OrbitFS through ChatGPT/MCP, what tools they call, and which workspace or target they touch.':'Current Engine runtime and readiness.'}</p></div><span>{engine.engineState}</span></div>
		{#if refreshedAt}<div class="refreshed">Refreshed {refreshedAt.toLocaleTimeString()}</div>{/if}

		<div class="facts">{#each cards as card}<span><small>{card[0]}</small><b>{card[1]}</b><em>{card[2]}</em></span>{/each}</div>

		{#if engine.id==='apex'}
			<section>
				<div class="section-title"><div><h2>Queue & processing activity</h2><p>Latest {activity.length} APEX jobs from the linked workspace.</p></div><span>{m.jobs||0} loaded</span></div>
				{#if activity.length}
					<div class="activity-list apex-list">
						{#each activity as job}
							<article class:error={job.status==='failed'}>
								<div class="activity-main"><div class="activity-head"><b>{job.sourceName}</b><span class="status">{human(job.status)}</span></div><p>{human(job.type)} · {human(job.stage)} · {job.progress}%</p><div class="progress"><i style={`width:${Math.max(0,Math.min(100,job.progress))}%`}></i></div></div>
								<div class="activity-meta"><span><small>User</small><b>{job.userName}</b></span><span><small>Mode</small><b>{human(job.importMode||'—')}</b></span><span><small>Attempts</small><b>{job.attempts}</b></span><span><small>Updated</small><b>{fmt(job.updatedAt)}</b></span></div>
								{#if job.sourcePath}<div class="target">Source: {job.sourcePath}</div>{/if}
								{#if job.error}<div class="job-error"><b>{job.errorCode||'APEX error'}</b><span>{job.error}</span></div>{/if}
							</article>
						{/each}
					</div>
				{:else}<div class="empty">No APEX queue activity yet. Jobs will appear here when users submit Knowledge imports, conversions or reprocessing work.</div>{/if}
			</section>
		{:else if engine.id==='mcp'}
			<section>
				<div class="section-title"><div><h2>Recent ChatGPT / MCP activity</h2><p>Audited tool actions. Content, prompts, file bodies and secrets are not stored here.</p></div><span>{activity.length} events</span></div>
				{#if activity.length}
					<div class="activity-list">
						{#each activity as event}
							<article class:error={event.status==='error'}>
								<div class="activity-head"><div><b>{human(event.tool)}</b><small>{human(event.category)}</small></div><span class="status">{event.status}</span></div>
								<div class="activity-meta"><span><small>User</small><b>{event.userName}</b></span><span><small>Client</small><b>{event.clientName}</b></span><span><small>Workspace</small><b>{event.workspaceName}</b></span><span><small>When</small><b>{fmt(event.createdAt)}</b></span></div>
								{#if targetText(event.target)}<div class="target">Target: {targetText(event.target)}</div>{/if}
								<div class="submeta">{#if event.durationMs}<span>{event.durationMs} ms</span>{/if}{#if event.conversationId}<span>Conversation {String(event.conversationId).slice(0,24)}</span>{/if}</div>
							</article>
						{/each}
					</div>
				{:else}<div class="empty">No audited MCP tool activity yet. New ChatGPT/MCP tool calls will appear here.</div>{/if}
			</section>

			<section>
				<div class="section-title"><div><h2>Recent sessions</h2><p>Users, clients, workspaces and request counts without loading conversation content.</p></div><span>{sessions.length} sessions</span></div>
				{#if sessions.length}<div class="session-grid">{#each sessions as session}<article><div><b>{session.userName}</b><span>{session.clientName}</span></div><dl><dt>Workspace</dt><dd>{session.workspaceName}</dd><dt>Status</dt><dd>{session.status}</dd><dt>Requests</dt><dd>{session.requestCount}</dd><dt>Last seen</dt><dd>{fmt(session.lastSeenAt)}</dd></dl></article>{/each}</div>{:else}<div class="empty">No MCP sessions recorded.</div>{/if}
			</section>
		{/if}

		<section>
			<div class="section-title"><div><h2>Readiness</h2><p>Operational checks for this Engine.</p></div><span>{data.readiness.ready?'Ready':`${data.readiness.blocking.length} blocking`}</span></div>
			<div class="checks">{#each data.readiness.checks as check}<div class:ok={check.ok}><span>{check.ok?'PASS':check.required?'BLOCK':'INFO'}</span><div><b>{check.label}</b><small>{check.description}</small></div></div>{/each}</div>
		</section>

		<section class="timestamps"><h2>Engine timestamps</h2><dl><dt>Last engine request</dt><dd>{fmt(m.lastRequestAt)}</dd><dt>Last runtime control</dt><dd>{fmt(m.lastControlAt)}</dd><dt>Last Panel sync</dt><dd>{fmt(m.lastSyncAt)}</dd>{#if engine.id==='mcp'}<dt>Last client seen</dt><dd>{fmt(m.lastClientSeenAt)}</dd><dt>Last session seen</dt><dd>{fmt(m.lastSessionSeenAt)}</dd>{/if}</dl></section>
	</main>
</div>

<style>
	:global(html){background:#090b0e;color:#eee;font-family:Inter,ui-sans-serif,system-ui}:global(body){margin:0;background:#090b0e}.shell{min-height:100vh}header{min-height:56px;border-bottom:1px solid #24282e;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 22px;background:#0b0d10;position:sticky;top:0;z-index:20}.brand{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:9px;font-size:10px;color:#747b83}nav a{color:#b5bac1;text-decoration:none}main{max-width:1120px;margin:0 auto;padding:22px 18px 64px}.toolbar{display:flex;justify-content:space-between;gap:10px;margin-bottom:13px}.toolbar a,.toolbar button{border:1px solid #343a42;background:#11151a;color:#b8bec5;text-decoration:none;padding:7px 10px;border-radius:6px;font-size:9px;cursor:pointer}.toolbar button:disabled{opacity:.5}.hero{display:flex;justify-content:space-between;align-items:end;gap:18px;border-bottom:1px solid #252a30;padding-bottom:18px}.hero small{font-size:9px;color:#7a8189;letter-spacing:.15em}.hero h1{font-size:29px;margin:4px 0 5px}.hero p{margin:0;color:#899099;font-size:11px;line-height:1.5;max-width:760px}.hero>span{border:1px solid #3b4148;padding:7px 10px;border-radius:999px;font-size:9px;text-transform:capitalize}.refreshed{text-align:right;color:#666e76;font-size:8px;margin-top:6px}.facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid #252a30;border-radius:9px;overflow:hidden;margin:16px 0}.facts span{padding:11px;border-right:1px solid #252a30;min-width:0}.facts span:last-child{border-right:0}.facts small{display:block;color:#737a82;font-size:8px;text-transform:uppercase}.facts b{display:block;margin-top:3px;font-size:15px;text-transform:capitalize}.facts em{display:block;font-style:normal;color:#70777f;font-size:8px;margin-top:2px}section{border:1px solid #252a30;background:#0d1014;padding:16px;border-radius:9px;margin-top:14px}section h2{font-size:15px;margin:0}.section-title{display:flex;align-items:start;justify-content:space-between;gap:12px}.section-title p{margin:4px 0 0;color:#747c84;font-size:9px;line-height:1.45}.section-title>span{font-size:8px;color:#777f87;white-space:nowrap}.activity-list{display:grid;gap:8px;margin-top:13px}.activity-list article{border:1px solid #282e35;background:#101419;border-radius:8px;padding:12px}.activity-list article.error{border-color:#643333}.activity-head{display:flex;align-items:start;justify-content:space-between;gap:12px}.activity-head>div{display:grid;gap:2px}.activity-head b,.activity-main b{font-size:11px}.activity-head small{font-size:8px;color:#777f87;text-transform:uppercase}.status{font-size:8px;border:1px solid #3a4148;border-radius:999px;padding:5px 7px;text-transform:capitalize;white-space:nowrap}.activity-main p{margin:3px 0 7px;color:#7d858d;font-size:9px;text-transform:capitalize}.activity-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid #242a30;margin-top:9px;padding-top:9px;gap:10px}.activity-meta small{display:block;color:#6f7780;font-size:7px;text-transform:uppercase}.activity-meta b{display:block;margin-top:2px;font-size:9px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.target,.submeta{margin-top:8px;color:#7b838b;font-size:8px;word-break:break-word}.submeta{display:flex;gap:10px;flex-wrap:wrap}.progress{height:4px;background:#22272d;border-radius:999px;overflow:hidden}.progress i{display:block;height:100%;background:#b7bdc4}.job-error{display:grid;gap:3px;border-top:1px solid #542f2f;margin-top:9px;padding-top:8px;color:#e3a0a0;font-size:9px}.empty{border:1px dashed #30363d;color:#737b84;padding:18px;border-radius:8px;margin-top:12px;font-size:9px}.session-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}.session-grid article{border:1px solid #282e35;background:#101419;border-radius:8px;padding:11px}.session-grid article>div{display:flex;justify-content:space-between;gap:10px;font-size:10px}.session-grid article>div span{color:#777f87;font-size:8px}.session-grid dl{margin-top:9px}.checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px;margin-top:10px}.checks>div{display:grid;grid-template-columns:55px minmax(0,1fr);gap:9px;padding:9px 0;border-top:1px solid #23282e}.checks>div>span{font-size:8px;color:#d19e68}.checks>div.ok>span{color:#73cf97}.checks b{font-size:9px}.checks small{display:block;color:#737b83;font-size:8px;margin-top:2px;line-height:1.4}dl{display:grid;grid-template-columns:140px minmax(0,1fr);gap:7px 10px;font-size:9px;margin:12px 0 0}dt{color:#747c84}dd{margin:0;word-break:break-word}.timestamps{margin-bottom:0}
	@media(max-width:760px){header{padding:0 14px}nav span{display:none}main{padding:17px 12px 48px}.hero{align-items:flex-start;flex-direction:column}.hero h1{font-size:25px}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}.facts span:nth-child(2){border-right:0}.facts span:nth-child(-n+2){border-bottom:1px solid #252a30}.activity-meta{grid-template-columns:repeat(2,minmax(0,1fr))}.session-grid,.checks{grid-template-columns:1fr}.toolbar{position:sticky;top:62px;z-index:10;background:#090b0e;padding:5px 0}.toolbar button{min-width:92px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:6px}}
	@media(max-width:430px){.activity-meta{grid-template-columns:1fr}.section-title{flex-direction:column}.facts b{font-size:13px}}
</style>
