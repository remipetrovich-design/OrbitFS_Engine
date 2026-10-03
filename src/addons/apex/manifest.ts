export const apexAddonManifest = {
	id: 'apex',
	name: 'OrbitFS APEX',
	description: 'Knowledge sorting, document conversion, ingest and routing engine for OrbitFS.',
	version: '2.0.0',
	kind: 'private-engine-addon',
	runtimeMode: 'engine-host',
	licenseComponent: 'orbitfs_apex',
	transportPath: null,
	sourceRef: 'orbitfsengine:apex',
	releaseTestMarker: 'license-master-handoff-2026-09-18',
	database: { mode: 'shared-panel', provider: 'supabase', owner: 'engine', isolated: false },
	capabilities: ['knowledge-sorter','knowledge-ingest','document-processing','routing','conversion','automation','library-knowledge'],
	dependencies: ['base.workspaces','base.library','base.knowledge','base.profiles','base.auth','base.permissions'],
	panelIntegration: {
		mode: 'integrated',
		installable: true,
		engineRequired: true,
		actions: ['install','deploy-engine','link-engine','unlink','uninstall']
	},
	frontend: {
		primaryNavigation: [],
		routes: [
			{ path: '/sorter-converter', component: 'apex-unit' },
			{ path: '/sorter-converter/sorter-settings', component: 'apex-sorter-settings' },
			{ path: '/sorter-converter/converter-settings', component: 'apex-converter-settings' },
			{ path: '/sorter-converter/master-control', component: 'apex-master-control' }
		],
		navigationGroups: [{
			label: 'Apex System', icon: 'FolderCog', order: 10, roles: ['owner','admin','user'],
			items: [
				{ label: 'Apex Unit', href: '/sorter-converter', icon: 'Sparkles', permission: 'sorter_view' },
				{ label: 'Apex Settings', href: '/sorter-converter/sorter-settings', icon: 'ListChecks', permission: 'sorter_manage_rules' },
				{ label: 'Apex Converter Settings', href: '/sorter-converter/converter-settings', icon: 'Settings2', permission: 'converter_manage_settings' },
				{ label: 'Apex Master Control', href: '/sorter-converter/master-control', icon: 'ShieldCheck', roles: ['owner','admin'] }
			]
		}],
		adminGroups: [],
		routeGuards: [
			{ prefix: '/sorter-converter/master-control', roles: ['owner','admin'] },
			{ prefix: '/sorter-converter', permission: 'sorter_view' }
		]
	}
} as const;