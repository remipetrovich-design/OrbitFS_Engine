import { json } from '@sveltejs/kit';
import { OAUTH_ISSUER, OAUTH_SCOPES, resolveRequestMcpResource } from '$lib/server/mcp-oauth';
import { assertAddonEngineAccepting } from '$lib/server/addon-engine';

export async function GET({ request }) {
	try {
		await assertAddonEngineAccepting('mcp',{requireSetup:false});
		const resource = await resolveRequestMcpResource(request);
		const engineOrigin = resource.replace(/\/mcp$/, '');
		return json({
			resource,
			authorization_servers: [OAUTH_ISSUER],
			bearer_methods_supported: ['header'],
			scopes_supported: [...OAUTH_SCOPES],
			resource_documentation: `${engineOrigin}/engines/mcp/configuration`
		}, { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return json({ error: String(error?.message || 'OrbitFS MCP unavailable'), code: String(error?.code || 'MCP_UNAVAILABLE') }, { status: Number(error?.status || 503), headers: { 'cache-control': 'no-store' } });
	}
}
