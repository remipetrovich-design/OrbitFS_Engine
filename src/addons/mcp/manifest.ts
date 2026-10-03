export const mcpAddonManifest = {
	id: 'mcp',
	name: 'OrbitFS MCP',
	description: 'Context, tools, OAuth and MCP client runtime for OrbitFS.',
	version: '1.5.0',
	kind: 'private-engine-addon',
	licenseComponent: 'orbitfs_mcp',
	runtimeMode: 'engine-host',
	transportPath: '/mcp',
	sourceRef: 'orbitfsengine:mcp',
	database: { mode: 'shared-panel', provider: 'supabase', owner: 'engine', isolated: false },
	releaseTestMarker: 'license-master-handoff-2026-09-18',
	capabilities: ['mcp','oauth-2.1','pkce','startup','context','chatgpt-ui','mcp-apps','library-context'],
	dependencies: ['base.workspaces','base.profiles','base.auth','base.permissions'],
	panelIntegration: {
		mode: 'integrated',
		installable: true,
		engineRequired: true,
		actions: ['install','deploy-engine','link-engine','unlink','uninstall']
	},
	frontend: {
		primaryNavigation: [],
		routes: [
			{ path: '/mcp', component: 'mcp-home' },
			{ path: '/mcp/access', component: 'mcp-access' },
			{ path: '/mcp/oss', component: 'mcp-oss' },
			{ path: '/mcp/projects', component: 'mcp-projects' },
			{ path: '/mcp/ccs', component: 'mcp-ccs' },
			{ path: '/mcp/context-library', component: 'mcp-context-library' },
			{ path: '/mcp/startup', component: 'mcp-startup' },
			{ path: '/mcp/system', component: 'mcp-settings' }
		],
		navigationGroups: [{
			label: 'MCP', icon: 'Plug', order: 20,
			items: [
				{ label: 'Overview', href: '/mcp', icon: 'Plug', permission: 'mcp_use' },
				{ label: 'Access & Workspaces', href: '/mcp/access', icon: 'Users', permission: 'mcp_use' },
				{ label: 'Startup System (OSS)', href: '/mcp/oss', icon: 'Sparkles', permission: 'manage_mcp_startup' },
				{ label: 'Projects', href: '/mcp/projects', icon: 'Folder', permission: 'manage_mcp_projects' },
				{ label: 'Context Bundles (CCS)', href: '/mcp/ccs', icon: 'ListTree', permission: 'manage_mcp_startup' },
				{ label: 'Context Library', href: '/mcp/context-library', icon: 'Library', permission: 'mcp_use' },
				{ label: 'Startup Defaults', href: '/mcp/startup', icon: 'BookOpen', permission: 'manage_mcp_startup' },
				{ label: 'MCP Settings', href: '/mcp/system', icon: 'Settings', permission: 'manage_mcp_settings' }
			]
		}],
		adminGroups: [],
		routeGuards: [{ prefix: '/mcp', permission: 'mcp_use' }]
	}
} as const;