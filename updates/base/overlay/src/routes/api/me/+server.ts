import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth';
import { assertPanelLicensed } from '$lib/server/license';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { writeAudit } from '$lib/server/audit';

async function present(user:any) {
	const supabase = getSupabaseAdmin();
	const [owned,memberships,sessions] = await Promise.all([
		supabase.from('orbitfs_workspaces').select('*',{count:'exact',head:true}).eq('owner_id',user.id).neq('status','archived'),
		supabase.from('orbitfs_workspace_members').select('*',{count:'exact',head:true}).eq('user_id',user.id),
		supabase.from('orbitfs_sessions').select('*',{count:'exact',head:true}).eq('user_id',user.id).gt('expires_at',new Date().toISOString())
	]);
	if (owned.error) throw owned.error; if (memberships.error) throw memberships.error; if (sessions.error) throw sessions.error;
	return { username:user.username,email:user.email,role:user.role,owned_workspaces:owned.count ?? 0,
		workspace_memberships:memberships.count ?? 0,active_sessions:sessions.count ?? 0 };
}

export async function GET({ cookies }) {
	try {
		const user = await requireUser(cookies); await assertPanelLicensed();
		return json({ user:await present(user) });
	} catch (error:any) { return json({ error:String(error?.message || 'Failed to load account') }, { status:Number(error?.status || 500) }); }
}
export async function PATCH({ request, cookies }) {
	try {
		const user = await requireUser(cookies); await assertPanelLicensed();
		const body = await request.json().catch(() => ({}));
		const patch:Record<string,any> = {};
		if (body.email !== undefined) {
			const email = String(body.email ?? '').trim().toLowerCase() || null;
			if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error:'Enter a valid email address' }, { status:400 });
			patch.email = email;
		}
		if (body.pin !== undefined || body.password !== undefined || body.newPassword !== undefined) {
			return json({ error:'Change your password from Account using your current password.' }, { status:400 });
		}
		if (!Object.keys(patch).length) return json({ error:'No account changes supplied' }, { status:400 });
		const supabase = getSupabaseAdmin();
		const updated = await supabase.from('orbitfs_users').update(patch).eq('id',user.id).select('*').single();
		if (updated.error) throw updated.error;
		await writeAudit({ actorUserId:user.id,action:'account.update',targetType:'user',targetId:user.id,detail:{ emailChanged:body.email !== undefined } });
		return json({ user:await present(updated.data) });
	} catch (error:any) { return json({ error:String(error?.message || 'Failed to update account') }, { status:Number(error?.status || 500) }); }
}
