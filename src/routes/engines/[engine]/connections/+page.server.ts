import { fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { writeAudit } from '$lib/server/audit';
import { apexEngineState, apexPolicy } from '$lib/server/apex-cloud';
import { getEngineHubEngine } from '$lib/server/engine-hub';
import { getStudioAdminSettings } from '$lib/server/studio-cloud';
import { getSupabaseAdmin } from '$lib/server/supabase';

export async function load({ cookies, params }) {
	const user = await requireAdmin(cookies);
	const engine = await getEngineHubEngine(params.engine);
	let clients: any[] = [];
	let sessions: any[] = [];
	let connectionDetails: any = null;

	if (engine.id === 'mcp') {
		const db = getSupabaseAdmin();
		const [clientResult, sessionResult] = await Promise.all([
			db.from('mcp_clients')
				.select('id,client_name,status,permissions,workspace_ids,first_seen_at,last_seen_at')
				.order('client_name')
				.limit(100),
			db.from('mcp_sessions')
				.select('id,client_id,user_id,username,workspace_id,provider,status,request_count,connected_at,last_seen_at')
				.order('last_seen_at', { ascending: false })
				.limit(100)
		]);
		if (clientResult.error) throw clientResult.error;
		if (sessionResult.error) throw sessionResult.error;
		clients = clientResult.data || [];
		sessions = sessionResult.data || [];
		connectionDetails = {
			transport: engine.hostUrl ? `${String(engine.hostUrl).replace(/\/$/, '')}/mcp` : null,
			authority: engine.panelUrl || null,
			clientCount: clients.length,
			activeSessions: sessions.filter((session: any) => String(session.status || 'active') === 'active').length
		};
	} else if (engine.id === 'apex') {
		const [policy, runtime] = await Promise.all([apexPolicy(user), Promise.resolve(apexEngineState() as any)]);
		connectionDetails = {
			backend: 'Shared Supabase workspace data',
			routing: 'OrbitFS cloud routing engine',
			target: runtime.sorter?.target || 'library-memory',
			processingMode: policy.serviceMode || 'on_demand',
			converterAvailable: runtime.converter?.available === true,
			converterReason: runtime.converter?.reason || null
		};
	} else if (engine.id === 'studio') {
		const studio = await getStudioAdminSettings(user);
		connectionDetails = {
			backend: 'Shared Supabase workspace data',
			routingEngine: studio.routing?.engine || 'orbitfs-base-routing-v2-cloud',
			provider: studio.routing?.provider || 'deterministic',
			semanticProvider: studio.routing?.semanticProvider || null,
			semanticProviderStatus: studio.routing?.semanticProviderStatus || 'not_configured',
			processingMode: studio.processing?.mode || 'serverless',
			requestDriven: studio.processing?.requestDriven !== false,
			storageProvider: studio.storageUsage?.provider || 'supabase'
		};
	}

	return { user, engine, clients, sessions, connectionDetails };
}

export const actions = {
	client: async ({ cookies, params, request }) => {
		const user = await requireAdmin(cookies);
		if (String(params.engine).toLowerCase() !== 'mcp') return fail(400, { error: 'Client controls apply to MCP only.' });
		const form = await request.formData();
		const clientId = String(form.get('clientId') || '').trim();
		const action = String(form.get('action') || '').trim().toLowerCase();
		if (!clientId || !['enable','disable'].includes(action)) return fail(400, { error: 'Client and action are required.' });
		const db = getSupabaseAdmin();
		const existing = await db.from('mcp_clients').select('id,client_name').eq('id', clientId).maybeSingle();
		if (existing.error) throw existing.error;
		if (!existing.data) return fail(404, { error: 'MCP client not found.' });
		const now = new Date().toISOString();
		const status = action === 'enable' ? 'active' : 'disabled';
		const updated = await db.from('mcp_clients').update({ status, last_seen_at: now }).eq('id', clientId);
		if (updated.error) throw updated.error;
		if (action === 'disable') {
			const tokenUpdate = await db.from('mcp_oauth_tokens').update({ revoked_at: now }).eq('client_id', clientId).is('revoked_at', null);
			if (tokenUpdate.error) throw tokenUpdate.error;
			const sessionUpdate = await db.from('mcp_sessions').update({ status: 'disconnected', last_seen_at: now }).eq('client_id', clientId).eq('status', 'active');
			if (sessionUpdate.error) throw sessionUpdate.error;
		}
		const engine = await getEngineHubEngine('mcp');
		await writeAudit({ actorUserId:String(user.id), workspaceId:engine.workspaceId || null, action:`engine.mcp.client.${action}`, targetType:'mcp_client', targetId:clientId, detail:{engineHost:engine.hostUrl || null,status} });
		return { ok:true, message:`${existing.data.client_name || clientId} ${action === 'enable' ? 'enabled' : 'disabled'}.` };
	},
	session: async ({ cookies, params, request }) => {
		const user = await requireAdmin(cookies);
		if (String(params.engine).toLowerCase() !== 'mcp') return fail(400, { error: 'Session controls apply to MCP only.' });
		const form = await request.formData();
		const sessionId = String(form.get('sessionId') || '').trim();
		if (!sessionId) return fail(400, { error: 'Session id is required.' });
		const db = getSupabaseAdmin();
		const now = new Date().toISOString();
		const existing = await db.from('mcp_sessions').select('id,client_id,status').eq('id', sessionId).maybeSingle();
		if (existing.error) throw existing.error;
		if (!existing.data) return fail(404, { error: 'MCP session not found.' });
		const updated = await db.from('mcp_sessions').update({ status:'disconnected', last_seen_at:now }).eq('id', sessionId);
		if (updated.error) throw updated.error;
		const engine = await getEngineHubEngine('mcp');
		await writeAudit({ actorUserId:String(user.id), workspaceId:engine.workspaceId || null, action:'engine.mcp.session.disconnect', targetType:'mcp_session', targetId:sessionId, detail:{engineHost:engine.hostUrl || null,clientId:existing.data.client_id || null} });
		return { ok:true, message:'MCP session disconnected.' };
	}
};
