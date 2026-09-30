<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();
	let engine = $derived(data.engine);
	let reviewed = $derived(Boolean(engine.configurationReviewedAt));
	let complete = $derived(engine.setupState === 'complete');
	let core = $derived(data.apex?.core || null);
	let setupLabel = $derived(String(engine.setupState || 'not_started').replaceAll('_', ' '));
	let panelReady = $derived(engine.linked === true && engine.licensed === true);
	let coreReady = $derived(engine.id !== 'apex' || core?.initialized === true);
	let pendingAction = $state<string | null>(null);
	let refreshing = $state(false);
	let refreshedAt = $state<Date | null>(null);

	const enhanceSetup = ({ formElement }: any) => {
		pendingAction = String(formElement?.dataset?.action || 'setup');
		return async ({ update }: any) => {
			try {
				await update({ reset: false, invalidateAll: true });
				refreshedAt = new Date();
			} finally {
				pendingAction = null;
			}
		};
	};

	async function refreshPanel() {
		if (refreshing || pendingAction) return;
		refreshing = true;
		try {
			await invalidateAll();
			refreshedAt = new Date();
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head><title>{engine.name} Setup · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="shell">
	<header>
		<a class="brand" href="/engines">OrbitFS Engine Host</a>
		<nav><a href={`/engines/${engine.id}`}>← {engine.name}</a><span>Setup</span></nav>
	</header>

	<main>
		<div class="toolbar">
			<a class="back" href={`/engines/${engine.id}`}>← Back to {engine.name}</a>
			<div class="toolbar-actions">
				{#if refreshedAt}<span>Updated {refreshedAt.toLocaleTimeString()}</span>{/if}
				<button class="refresh" type="button" onclick={refreshPanel} disabled={refreshing || Boolean(pendingAction)}>{refreshing ? 'Refreshing…' : '↻ Refresh'}</button>
			</div>
		</div>

		<div class="hero">
			<div><small>{complete ? 'SETUP COMPLETE' : 'FIRST-TIME SETUP'}</small><h1>{engine.fullName}</h1><p>{complete ? 'Initial setup is finished. Reopen it only when you need to re-run setup checks.' : 'Connect the Engine, build required components, review configuration, then complete setup.'}</p></div>
			<span class:ready={data.ready}>{complete ? 'Complete' : data.ready ? 'Ready to complete' : `${data.blocking.length} blocking`}</span>
		</div>

		<div class="livebar" aria-live="polite">
			<span class:ok={panelReady}><b>Panel</b>{panelReady ? 'Linked' : 'Waiting'}</span>
			{#if engine.id === 'apex'}<span class:ok={coreReady}><b>Core</b>{coreReady ? 'Ready' : 'Needs build'}</span>{/if}
			<span class:ok={reviewed}><b>Config</b>{reviewed ? 'Reviewed' : 'Needs review'}</span>
			<span class:ok={data.ready}><b>Checks</b>{data.ready ? 'Passing' : `${data.blocking.length} blocking`}</span>
			<span class:ok={complete}><b>Setup</b>{complete ? 'Complete' : setupLabel}</span>
		</div>

		{#if form?.error}<div class="notice error" aria-live="assertive"><b>Setup error</b><span>{form.error}</span></div>{/if}
		{#if form?.message}<div class="notice ok" aria-live="polite">{form.message}</div>{/if}
		{#if pendingAction}<div class="notice working" aria-live="polite"><span class="dot"></span>Working: {pendingAction.replaceAll('_', ' ')}…</div>{/if}

		{#if complete}
			<section class="complete-card">
				<div><small>STATUS</small><h2>Setup completed successfully</h2><p>Runtime and configuration remain available without keeping the first-time wizard in your normal workflow.</p></div>
				<div class="summary">
					<span><small>Panel</small><b>{engine.linked ? 'Linked' : 'Not linked'}</b></span>
					<span><small>Workspace</small><b>{engine.workspaceName || engine.workspaceId || 'Not assigned'}</b></span>
					<span><small>Configuration</small><b>{reviewed ? 'Reviewed' : 'Needs review'}</b></span>
					{#if engine.id === 'apex'}<span><small>APEX core</small><b>{core?.initialized ? 'Initialized' : 'Not initialized'}</b></span>{/if}
				</div>
				<div class="actions">
					<a class="primary-link" href={`/engines/${engine.id}`}>Back to Engine</a>
					<a href={`/engines/${engine.id}/configuration`}>Configuration</a>
					<a href={`/engines/${engine.id}/diagnostics`}>Diagnostics</a>
					{#if data.canManage}<form method="POST" action="?/rerun" data-action="reopen setup" use:enhance={enhanceSetup}><button disabled={Boolean(pendingAction)}>{pendingAction === 'reopen setup' ? 'Reopening…' : 'Run setup again'}</button></form>{/if}
				</div>
			</section>
		{:else}
			<div class="setup-grid">
				<section class:step-ready={panelReady}>
					<div class="section-head"><span>1</span><div><h2>Panel connection</h2><p>APEX must be installed, licensed and linked from the OrbitFS Panel.</p></div><em>{panelReady ? 'READY' : 'WAITING'}</em></div>
					<div class="rows"><div><span>Panel link</span><b>{engine.linked ? 'Connected' : 'Not connected'}</b></div><div><span>Workspace</span><b>{engine.workspaceName || engine.workspaceId || 'Not assigned'}</b></div><div><span>Licence</span><b>{engine.licensed ? 'Allowed' : 'Required'}</b></div></div>
				</section>

				{#if engine.id === 'apex'}
					<section class:step-ready={coreReady}>
						<div class="section-head"><span>2</span><div><h2>APEX processing core</h2><p>The shared serverless processing core is Engine-owned state in Supabase. There is no separate service or package to install.</p></div><em>{coreReady ? 'READY' : 'BUILD'}</em></div>
						<div class="core-state"><span><small>Status</small><b>{core?.initialized ? 'Initialized' : 'Not initialized'}</b></span><span><small>Version</small><b>{core?.version || '—'}</b></span><span><small>Storage</small><b>{core?.storage || 'Supabase'}</b></span><span><small>Mode</small><b>{core?.mode || 'serverless'}</b></span></div>
						{#if data.canManage && engine.linked}<form method="POST" action="?/core" data-action="processing core" use:enhance={enhanceSetup}><button class="primary" disabled={Boolean(pendingAction)}>{pendingAction === 'processing core' ? 'Checking core…' : core?.initialized ? 'Verify processing core' : 'Initialize processing core'}</button></form>{/if}
					</section>
				{/if}

				<section class:step-ready={reviewed}>
					<div class="section-head"><span>{engine.id === 'apex' ? '3' : '2'}</span><div><h2>Configuration review</h2><p>Review the settings the Engine actually uses before marking this step complete.</p></div><em>{reviewed ? 'READY' : 'REVIEW'}</em></div>
					<div class="actions"><a class="primary-link" href={`/engines/${engine.id}/configuration`}>Open configuration</a>{#if engine.id === 'mcp'}<a href={`/engines/${engine.id}/connections`}>Connections</a><a href={`/engines/${engine.id}/oauth`}>OAuth</a>{/if}<a href={`/engines/${engine.id}/runtime`}>Runtime</a></div>
					<div class="review"><span>Configuration reviewed</span><b>{reviewed ? new Date(engine.configurationReviewedAt).toLocaleString() : 'No'}</b></div>
					{#if data.canManage && engine.linked && !reviewed}<form method="POST" action="?/review" data-action="configuration review" use:enhance={enhanceSetup}><button disabled={Boolean(pendingAction) || (engine.id === 'apex' && !core?.initialized)}>{pendingAction === 'configuration review' ? 'Recording…' : 'Mark configuration reviewed'}</button></form>{/if}
				</section>

				<section class="checks-card" class:step-ready={data.ready}>
					<div class="section-head"><span>{engine.id === 'apex' ? '4' : '3'}</span><div><h2>Readiness checks</h2><p>Only required failures block setup completion. Use Refresh whenever external Panel state changes.</p></div><em>{data.ready ? 'READY' : `${data.blocking.length} BLOCK`}</em></div>
					<div class="checks">{#each data.checks as check}<div class:pass={check.ok}><em>{check.ok ? 'PASS' : check.required ? 'BLOCK' : 'INFO'}</em><div><b>{check.label}</b><small>{check.description}</small></div></div>{/each}</div>
				</section>

				<section class="control-card" class:step-ready={complete}>
					<div class="section-head"><span>{engine.id === 'apex' ? '5' : '4'}</span><div><h2>Build and complete setup</h2><p>Start/build verifies required Engine pieces, then completion marks the add-on configured for the shared OrbitFS installation.</p></div><em>{data.ready ? 'READY' : 'BUILD'}</em></div>
					<div class="rows"><div><span>Current state</span><b>{setupLabel}</b></div><div><span>Blocking checks</span><b>{data.blocking.length}</b></div><div><span>Panel configured flag</span><b>{engine.configured ? 'Yes' : 'No — set on completion'}</b></div></div>
					{#if data.canManage}
						<div class="control-actions">
							<form method="POST" action="?/begin" data-action="build setup" use:enhance={enhanceSetup}><button class="build" disabled={Boolean(pendingAction) || !engine.linked}>{pendingAction === 'build setup' ? 'Building setup…' : engine.setupState === 'in_progress' ? 'Re-run setup build' : 'Begin / build setup'}</button></form>
							<form method="POST" action="?/complete" data-action="complete setup" use:enhance={enhanceSetup}><button class="primary complete" disabled={Boolean(pendingAction) || !data.ready}>{pendingAction === 'complete setup' ? 'Completing…' : 'Complete setup'}</button></form>
						</div>
					{/if}
				</section>
			</div>
		{/if}
	</main>
</div>

<style>
	:global(html){background:#090b0e;color:#eee;font-family:Inter,ui-sans-serif,system-ui}:global(body){margin:0;background:#090b0e}.shell{min-height:100vh}header{min-height:56px;border-bottom:1px solid #24282e;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 22px;background:#0b0d10;position:sticky;top:0;z-index:20}.brand{color:#fff;text-decoration:none;font-weight:700;font-size:13px}nav{display:flex;gap:10px;align-items:center;color:#70767e;font-size:10px}nav a{color:#b5bac1;text-decoration:none}main{max-width:1120px;margin:0 auto;padding:24px 18px 64px}.toolbar{margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:12px}.toolbar-actions{display:flex;align-items:center;gap:9px}.toolbar-actions span{font-size:8px;color:#686f77}.back,.refresh{display:inline-flex;align-items:center;color:#aeb4bb;text-decoration:none;font-size:10px;border:1px solid #30353c;padding:7px 9px;border-radius:6px;background:#0d1014}.refresh{cursor:pointer}.refresh:disabled{opacity:.5}.hero{display:flex;align-items:end;justify-content:space-between;gap:20px;border-bottom:1px solid #252a30;padding-bottom:18px}.hero small,.complete-card>div>small{font-size:9px;letter-spacing:.15em;color:#7c838b}.hero h1{font-size:30px;margin:4px 0 5px}.hero p,.complete-card p{margin:0;max-width:700px;color:#8b929a;font-size:12px;line-height:1.55}.hero>span{border:1px solid #40464e;padding:7px 10px;border-radius:999px;font-size:9px;white-space:nowrap}.hero>span.ready{border-color:#2d6846;color:#91deb0}.livebar{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid #252a30;border-radius:8px;overflow:hidden;margin-top:14px;background:#0c0f12}.livebar span{padding:9px 10px;border-right:1px solid #252a30;color:#8b929a;font-size:9px;min-width:0}.livebar span:last-child{border-right:0}.livebar b{display:block;color:#d5d9dd;font-size:8px;text-transform:uppercase;margin-bottom:2px}.livebar span.ok{color:#8bd7a8}.notice{display:flex;gap:8px;align-items:center;padding:11px 13px;border:1px solid #343a42;margin:14px 0;border-radius:7px;font-size:11px}.notice.error{border-color:#6d3131;color:#f2b6b6;background:#160d0d}.notice.ok{border-color:#2d6846;color:#9ee0b8;background:#0d1711}.notice.working{border-color:#4a5563;color:#cbd2da;background:#10151b}.dot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulse 1s infinite}@keyframes pulse{50%{opacity:.3}}.setup-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:16px}.setup-grid section,.complete-card{border:1px solid #252a30;background:#0d1014;border-radius:9px;padding:17px;min-width:0;transition:border-color .18s ease,background .18s ease}.setup-grid section.step-ready{border-color:#2a4b38;background:#0d1210}.checks-card{grid-column:1/-1}.control-card{grid-column:1/-1}.section-head{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;align-items:start}.section-head>span{width:26px;height:26px;display:grid;place-items:center;border:1px solid #343a42;border-radius:7px;color:#aab0b7;font-size:9px}.section-head h2,.complete-card h2{font-size:15px;margin:1px 0 4px}.section-head p{margin:0;color:#7f868f;font-size:10px;line-height:1.5}.section-head>em{font-style:normal;font-size:8px;color:#b58b5f;padding-top:5px}.step-ready .section-head>em{color:#76ce99}.rows{margin-top:13px}.rows>div,.review{display:grid;grid-template-columns:170px minmax(0,1fr);gap:12px;padding:8px 0;border-top:1px solid #23272d;font-size:10px}.rows span,.review span{color:#777e86}.rows b,.review b{font-weight:600;word-break:break-word}.core-state,.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid #262b31;margin:13px 0}.core-state span,.summary span{padding:10px;border-right:1px solid #262b31;min-width:0}.core-state span:last-child,.summary span:last-child{border-right:0}.core-state small,.summary small{display:block;color:#737a82;font-size:8px;text-transform:uppercase}.core-state b,.summary b{display:block;margin-top:3px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions,.control-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.actions a,button{box-sizing:border-box;border:1px solid #373d45;background:#15191e;color:#ddd;text-decoration:none;padding:8px 11px;border-radius:6px;font-size:9px;cursor:pointer}.actions a:hover,button:hover:not(:disabled){border-color:#555d67}.actions .primary-link,button.primary{background:#eee;color:#0a0c0f;border-color:#eee}.control-actions form{margin:0;flex:1}.control-actions button{width:100%;min-height:38px}.control-actions .build{background:#171c22}.control-actions .complete{font-weight:700}.actions form{margin:0}button:disabled{opacity:.35;cursor:not-allowed}.review{margin-top:12px}.checks{margin-top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}.checks>div{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px;padding:10px 0;border-top:1px solid #23272d}.checks em{font-style:normal;font-size:8px;color:#d2a36e}.checks>div.pass em{color:#74d299}.checks b{font-size:10px}.checks small{display:block;color:#747b83;font-size:9px;margin-top:2px;line-height:1.45}.complete-card{margin-top:16px}.complete-card .actions{margin-top:16px}
	@media(max-width:900px){.setup-grid{grid-template-columns:1fr}.checks-card,.control-card{grid-column:auto}.checks{grid-template-columns:1fr}.livebar{grid-template-columns:repeat(2,minmax(0,1fr))}.livebar span{border-bottom:1px solid #252a30}.livebar span:nth-child(even){border-right:0}.livebar span:last-child{border-bottom:0}}
	@media(max-width:650px){header{padding:0 12px}.brand{font-size:12px}nav span{display:none}main{padding:14px 10px 42px}.toolbar{position:sticky;top:61px;z-index:10;background:#090b0e;padding:6px 0;align-items:stretch}.toolbar-actions span{display:none}.back,.refresh{justify-content:center;min-height:34px}.hero{align-items:flex-start;flex-direction:column}.hero h1{font-size:24px}.hero p{font-size:11px}.livebar{grid-template-columns:1fr}.livebar span{border-right:0}.section-head{grid-template-columns:28px minmax(0,1fr)}.section-head>em{grid-column:2}.core-state,.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.core-state span:nth-child(2),.summary span:nth-child(2){border-right:0}.core-state span:nth-child(-n+2),.summary span:nth-child(-n+2){border-bottom:1px solid #262b31}.rows>div,.review{grid-template-columns:1fr;gap:3px}.actions,.control-actions{display:grid;grid-template-columns:1fr}.actions a,.actions form,.actions button,.control-actions form,.control-actions button{width:100%;text-align:center}}
</style>