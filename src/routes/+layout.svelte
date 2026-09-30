<script lang="ts">
	let { children } = $props();
</script>

{@render children()}

<style>
	:global(html){background:#050505;color:#ededed;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
	:global(body){margin:0;min-width:320px;background:#050505;color:#ededed}
	:global(*){box-sizing:border-box}
	:global(.app),:global(.shell){background:#050505!important;color:#ededed!important;min-height:100vh}
	:global(.glow){display:none!important}
	:global(.app>header),:global(.shell>header){height:58px!important;padding:0 20px!important;background:#080808!important;border-bottom:1px solid #242424!important;backdrop-filter:none!important;box-shadow:none!important}
	:global(.shell>header>a){color:#ededed!important;text-decoration:none!important;font-weight:700!important;font-size:12px!important}
	:global(.shell>header nav){font-size:10px!important;color:#707070!important}
	:global(.shell>header nav a){color:#a3a3a3!important;text-decoration:none!important}
	:global(.brand){color:#ededed!important;gap:9px!important;text-decoration:none!important}
	:global(.brand .mark),:global(.mark){width:30px!important;height:30px!important;border-radius:4px!important;background:#111!important;border:1px solid #333!important;color:#ededed!important;box-shadow:none!important;font-size:13px!important}
	:global(.brand small){color:#737373!important;font-size:9px!important}
	:global(.crumb),:global(.head-actions),:global(.account){font-size:10px!important;color:#707070!important}
	:global(.crumb a),:global(.head-actions a),:global(.account a){color:#a3a3a3!important;text-decoration:none!important}
	:global(.crumb b){color:#d4d4d4!important}
	:global(.app>main){max-width:1180px!important;margin:0 auto!important;padding:28px 22px 52px!important}
	:global(.shell>main:not(.card)){width:100%!important;margin-left:auto!important;margin-right:auto!important;padding-top:28px!important}
	:global(.heading){margin-bottom:18px!important}
	:global(.heading h1),:global(.hero h1),:global(.title h1){font-size:28px!important;line-height:1.15!important;letter-spacing:-.02em!important}
	:global(.heading p:not(.eyebrow)),:global(.hero p:not(.eyebrow)),:global(.title p),:global(.lead),:global(.note),:global(.muted),:global(.help){color:#929292!important;line-height:1.55!important}
	:global(.eyebrow),:global(.title>div>small){color:#858585!important;font-size:9px!important;letter-spacing:.12em!important;font-weight:750!important}
	:global(.panel),:global(.card),:global(.status-card),:global(.engine-card),:global(.installation),:global(.health),:global(.score),:global(.state),
	:global(.cards>div),:global(.stats>div),:global(.summary>div),:global(.status-grid>div),:global(.modes>div),:global(.flow>div),
	:global(.connection-grid>div),:global(.detail-grid>div),:global(.deployment-grid>div),:global(.service-grid>div),:global(.facts>div),
	:global(.scopes>div),:global(.context>div),:global(.workspace-list>div),:global(.access),:global(.check),:global(.checks>div),
	:global(details),:global(.notice),:global(.alert),:global(.warning),:global(.wake-box),:global(.shell section){background:#0b0b0b!important;background-image:none!important;border-color:#292929!important;border-radius:6px!important;box-shadow:none!important}
	:global(.panel),:global(.shell section){padding:16px!important;margin-top:12px!important}
	:global(.panel-head){gap:12px!important}
	:global(.panel h2),:global(.shell section h2){font-size:17px!important;font-weight:650!important}
	:global(.cards),:global(.stats),:global(.summary),:global(.status-grid){gap:8px!important;margin:16px 0!important}
	:global(.cards>div),:global(.stats>div),:global(.summary>div),:global(.status-grid>div){padding:11px!important}
	:global(.cards small),:global(.stats small),:global(.summary small),:global(.card span),:global(.status-card span){color:#737373!important;font-size:8px!important}
	:global(.cards strong),:global(.stats b),:global(.summary b){font-size:13px!important}
	:global(.cards span),:global(.stats span),:global(.summary span){color:#777!important;font-size:9px!important}
	:global(.pill),:global(.badge),:global(.state){background:#101010!important;border:1px solid #343434!important;border-radius:4px!important;color:#a3a3a3!important;box-shadow:none!important}
	:global(.pill.ok),:global(.badge.ok),:global(.badge.ready),:global(.health.ready),:global(.score.ready){border-color:#28583d!important;color:#75c99d!important;background:#0b120e!important}
	:global(.warn),:global(.warning),:global(.alert.warn){border-color:#59451f!important;color:#d2b36d!important;background:#121006!important}
	:global(.error),:global(.alert.error),:global(.notice.error){border-color:#662a2a!important;color:#e6a7a7!important;background:#140909!important}
	:global(.success),:global(.alert.success),:global(.notice.ok){border-color:#28583d!important;color:#8fd4ad!important;background:#09110d!important}
	:global(button),:global(.actions a),:global(.review-links a),:global(.engine-actions a),:global(.config-link),:global(.host-link),:global(.buttons a),:global(.links a){background:#111!important;background-image:none!important;border:1px solid #343434!important;border-radius:4px!important;box-shadow:none!important;color:#d4d4d4!important;text-decoration:none!important;filter:none!important}
	:global(button:hover),:global(.actions a:hover),:global(.review-links a:hover),:global(.engine-actions a:hover),:global(.buttons a:hover),:global(.links a:hover){background:#181818!important;border-color:#494949!important;transform:none!important}
	:global(button.primary),:global(.primary-link),:global(.engine-actions a.primary){background:#e5e5e5!important;border-color:#e5e5e5!important;color:#0a0a0a!important}
	:global(button.danger){background:#160a0a!important;border-color:#662a2a!important;color:#e6a7a7!important}
	:global(button:disabled){opacity:.4!important}
	:global(input),:global(select),:global(textarea){background:#080808!important;border:1px solid #333!important;border-radius:4px!important;color:#ededed!important;box-shadow:none!important;outline:none!important}
	:global(input:focus),:global(select:focus),:global(textarea:focus){border-color:#666!important;box-shadow:none!important}
	:global(code){color:#c4c4c4!important}
	:global(.flow),:global(.security-flow){gap:7px!important}
	:global(.flow>div),:global(.security-flow span){background:#0b0b0b!important;border-color:#292929!important;border-radius:4px!important}
	:global(.flow>div>b),:global(.checks>div>b),:global(.status){background:#151515!important;color:#aaa!important;border-radius:4px!important}
	:global(.check.ok .status),:global(.checks>div.ok>b){background:#0c1811!important;color:#75c99d!important}
	:global(.event-head>code),:global(.context>div),:global(.detail-grid>div){background:#080808!important;border-color:#242424!important}
	:global(.log),:global(.row),:global(.line),:global(.list a){border-color:#242424!important}
	:global(.row.head){color:#707070!important}
	:global(.engine:hover){transform:none!important;box-shadow:none!important;border-color:#3a3a3a!important}
	:global(.icon){background:#111!important;border:1px solid #2f2f2f!important;color:#c4c4c4!important;border-radius:4px!important}
	:global(.shell>.card){width:min(100%,440px)!important;padding:24px!important;background:#0a0a0a!important;border:1px solid #292929!important;border-radius:6px!important;box-shadow:none!important}
	:global(.shell .notice){border-radius:4px!important}
	:global(.shell>.card button){width:100%!important;justify-content:center!important}
	@media(max-width:700px){:global(.app>header),:global(.shell>header){padding:0 14px!important}:global(.app>main){padding:22px 14px 42px!important}:global(.shell>main:not(.card)){padding-top:22px!important}:global(.heading h1),:global(.hero h1),:global(.title h1){font-size:24px!important}}
</style>
