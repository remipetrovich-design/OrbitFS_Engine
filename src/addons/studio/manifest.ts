export const studioAddonManifest = {
	id: 'studio',
	name: 'OrbitFS Studio',
	description: 'Studio processing, document and analysis runtime for OrbitFS.',
	version: '1.0.0',
	kind: 'private-engine-addon',
	runtimeMode: 'engine-host',
	licenseComponent: 'orbitfs_studio',
	transportPath: null,
	sourceRef: 'orbitfsengine:studio',
	database: { mode: 'shared-panel', provider: 'supabase', owner: 'engine', isolated: false },
	capabilities: ['studio-runtime','documents','analysis','processing','providers'],
	dependencies: ['base.workspaces','base.library','base.profiles','base.auth','base.permissions'],
	panelIntegration: {
		mode: 'integrated',
		installable: true,
		engineRequired: true,
		actions: ['install','deploy-engine','link-engine','unlink','uninstall']
	},
	frontend: {
		primaryNavigation: [],
		routes: [],
		navigationGroups: [],
		adminGroups: [],
		routeGuards: []
	}
} as const;