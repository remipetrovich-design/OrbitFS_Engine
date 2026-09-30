import { json } from '@sveltejs/kit';
import { MCP_RESOURCE, OAUTH_ISSUER, OAUTH_SCOPES } from '$lib/server/mcp-oauth';
import { assertAddonEngineAccepting } from '$lib/server/addon-engine';

export async function GET() {
	try {
		await assertAddonEngineAccepting('mcp');
		const engineOrigin = MCP_RESOURCE.replace(/\/mcp$/, '');
		return json({
			resource: MCP_RESOURCE,
			authorization_servers: [OAUTH_ISSUER],
			bearer_methods_supported: ['header'],
			scopes_supported: [...OAUTH_SCOPES],
			resource_documentation: `${engineOrigin}/engines/mcp/configuration`
		}, { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return json({ error: String(error?.message || 'OrbitFS MCP unavailable'), code: String(error?.code || 'MCP_UNAVAILABLE') }, { status: Number(error?.status || 503), headers: { 'cache-control': 'no-store' } });
	}
}
