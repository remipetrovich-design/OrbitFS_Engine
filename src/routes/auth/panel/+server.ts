import { createHash } from 'node:crypto';
import { error, redirect } from '@sveltejs/kit';
import { createSession, type OrbitUser } from '$lib/server/auth';
import { assertAddonEngineLicensed } from '$lib/server/addon-engine';
import { engineAccess } from '$lib/server/engine-access';
import { getEngineHubEngine } from '$lib/server/engine-hub';
import { ensureInstallationIdentity } from '$lib/server/license';
import { getSupabaseAdmin } from '$lib/server/supabase';

function safeTicket(value:unknown){
	const ticket=String(value||'').trim();
	if(!/^[A-Za-z0-9_-]{40,64}$/.test(ticket))throw error(400,'Invalid Engine handoff ticket');
	return ticket;
}

export async function GET({url,cookies,request}:any){
	const ticket=safeTicket(url.searchParams.get('ticket'));
	const ticketHash=createHash('sha256').update(ticket).digest('hex');
	const installationId=await ensureInstallationIdentity();
	const db=getSupabaseAdmin();

	const consumed=await db.rpc('orbitfs_consume_engine_session_handoff',{
		p_ticket_hash:ticketHash,
		p_installation_id:installationId
	});
	if(consumed.error){
		const code=String(consumed.error.code||'');
		if(['PGRST202','42883','42P01'].includes(code))throw error(503,'Engine session handoff database contract is unavailable');
		throw consumed.error;
	}
	const handoff=Array.isArray(consumed.data)?consumed.data[0]:consumed.data;
	if(!handoff)throw error(401,'Engine handoff ticket is invalid, expired or already used');

	const engineId=String(handoff.engine_id||'').trim().toLowerCase();
	const destination=String(handoff.redirect_path||'').trim();
	if(!['mcp','apex','studio'].includes(engineId))throw error(400,'Invalid Engine handoff component');
	if(destination!==`/engines/${engineId}`&&!destination.startsWith(`/engines/${engineId}/`))throw error(400,'Invalid Engine handoff destination');

	const userResult=await db.from('orbitfs_users')
		.select('id,username,display_name,email,role,status,avatar_url,permissions,must_change_pin,ban_reason')
		.eq('id',String(handoff.user_id||''))
		.maybeSingle();
	if(userResult.error)throw userResult.error;
	const user=userResult.data as OrbitUser|null;
	if(!user||user.status!=='active')throw error(403,'OrbitFS user is not active');

	await assertAddonEngineLicensed(engineId);
	const engine=await getEngineHubEngine(engineId);
	if(!engine.installed||!engine.attached||!engine.linked)throw error(409,'Engine component is not linked to this installation');
	const access=await engineAccess(user,engineId);
	if(!access.allowed)throw error(403,'You do not have workspace permission to use this OrbitFS engine');

	const forwarded=String(request.headers.get('x-forwarded-for')||'').split(',')[0]?.trim()||null;
	await createSession(String(user.id),cookies,{
		userAgent:request.headers.get('user-agent'),
		ip:forwarded,
		secure:true
	});

	throw redirect(303,destination);
}
