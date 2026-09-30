import { fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { writeAudit } from '$lib/server/audit';
import { getEngineHubEngine } from '$lib/server/engine-hub';
import { MCP_RESOURCE, OAUTH_ISSUER, OAUTH_SCOPES } from '$lib/server/mcp-oauth';
import { getSupabaseAdmin } from '$lib/server/supabase';

export async function load({ cookies, params }) {
	const user = await requireAdmin(cookies);
	const engine = await getEngineHubEngine(params.engine);
	if (engine.id !== 'mcp') return { user, engine, applicable:false, clients:[], tokens:[], endpoints:null };
	const db = getSupabaseAdmin();
	const [clientsResult,tokensResult] = await Promise.all([
		db.from('mcp_oauth_clients').select('client_id,client_name,redirect_uris,scope,application_type,client_uri,created_at,updated_at').order('created_at',{ascending:false}).limit(100),
		db.from('mcp_oauth_tokens').select('client_id,user_id,scope,resource,expires_at,refresh_expires_at,revoked_at,created_at,last_used_at').order('created_at',{ascending:false}).limit(250)
	]);
	if (clientsResult.error) throw clientsResult.error;
	if (tokensResult.error) throw tokensResult.error;
	return {
		user,engine,applicable:true,
		clients:clientsResult.data || [],tokens:tokensResult.data || [],
		endpoints:{
			issuer:OAUTH_ISSUER,
			resource:MCP_RESOURCE,
			authorization:`${OAUTH_ISSUER}/oauth/authorize`,
			token:`${OAUTH_ISSUER}/oauth/token`,
			registration:`${OAUTH_ISSUER}/oauth/register`,
			scopes:[...OAUTH_SCOPES]
		}
	};
}

export const actions = {
	revoke: async ({ cookies, params, request }) => {
		const user = await requireAdmin(cookies);
		if (String(params.engine).toLowerCase() !== 'mcp') return fail(400,{error:'OAuth applies to MCP only.'});
		const form = await request.formData();
		const clientId = String(form.get('clientId') || '').trim();
		if (!clientId) return fail(400,{error:'Client id is required.'});
		const engine = await getEngineHubEngine('mcp');
		const db = getSupabaseAdmin();
		const existing = await db.from('mcp_oauth_clients').select('client_id').eq('client_id',clientId).maybeSingle();
		if (existing.error) throw existing.error;
		if (!existing.data) return fail(404,{error:'OAuth client not found.'});
		const now = new Date().toISOString();
		const result = await db.from('mcp_oauth_tokens').update({revoked_at:now}).eq('client_id',clientId).is('revoked_at',null);
		if (result.error) throw result.error;
		await writeAudit({
			actorUserId:String(user.id),
			workspaceId:engine.workspaceId || null,
			action:'engine.mcp.oauth.revoke_tokens',
			targetType:'mcp_oauth_client',
			targetId:clientId,
			detail:{engine:'mcp',resource:MCP_RESOURCE}
		});
		return {ok:true,message:`Revoked active tokens for ${clientId}.`};
	}
};
