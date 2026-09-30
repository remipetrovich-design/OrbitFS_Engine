export const apexAddonManifest = {
	id: 'apex',
	name: 'OrbitFS APEX',
	description: 'Knowledge ingest, document processing, routing and conversion engine for OrbitFS.',
	version: '2.0.0',
	kind: 'private-engine-addon',
	runtimeMode: 'engine-host',
	licenseComponent: 'orbitfs_apex',
	transportPath: null,
	sourceRef: 'orbitfsengine:apex',
	releaseTestMarker: 'license-master-handoff-2026-09-18',
	database: { mode: 'shared-panel', provider: 'supabase', owner: 'panel', isolated: false },
	capabilities: ['knowledge-ingest', 'document-processing', 'routing', 'conversion', 'automation', 'library-knowledge'],
	dependencies: ['base.workspaces', 'base.library', 'base.knowledge', 'base.profiles', 'base.auth', 'base.permissions']
} as const;
