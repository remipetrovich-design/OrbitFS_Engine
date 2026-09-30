import { apexAddonManifest } from '../../../addons/apex/manifest';
import { mcpAddonManifest } from '../../../addons/mcp/manifest';
import { handleMcpAddonRequest } from '../../../addons/mcp/server/mcp-server';

export type PanelAddonManifest = {
	id: string;
	name: string;
	description: string;
	version: string;
	kind: string;
};

const manifests = new Map<string, PanelAddonManifest>([
	[mcpAddonManifest.id, mcpAddonManifest],
	[apexAddonManifest.id, apexAddonManifest]
]);

export function getPanelAddonManifest(id: string) {
	return manifests.get(id) ?? null;
}

export async function dispatchPanelAddonHttp(id: string, request: Request): Promise<Response> {
	if (id === 'mcp') return handleMcpAddonRequest(request);
	return new Response(JSON.stringify({ error: 'Addon route not found' }), {
		status: 404,
		headers: { 'content-type': 'application/json' }
	});
}
