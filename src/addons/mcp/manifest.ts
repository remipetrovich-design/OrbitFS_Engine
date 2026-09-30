export const mcpAddonManifest = {
	id: 'mcp',
	name: 'OrbitFS MCP',
	description: 'OAuth-authenticated startup, context, ChatGPT UI and MCP tools for OrbitFS.',
	version: '1.5.0',
	kind: 'private-engine-addon',
	licenseComponent: 'orbitfs_mcp',
	runtimeMode: 'engine-host',
	transportPath: '/mcp',
	sourceRef: 'orbitfsengine:mcp',
	database: { mode: 'shared-panel', provider: 'supabase', owner: 'panel', isolated: false },
	releaseTestMarker: 'license-master-handoff-2026-09-18',
	capabilities: ['mcp', 'oauth-2.1', 'pkce', 'startup', 'context', 'chatgpt-ui', 'mcp-apps'],
	dependencies: ['base.workspaces', 'base.profiles', 'base.auth', 'base.permissions']
} as const;
