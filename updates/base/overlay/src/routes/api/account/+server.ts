import { json } from '@sveltejs/kit';
import { hashPassword, requireUser, verifyPassword } from '$lib/server/auth';
import { getSupabaseAdmin } from '$lib/server/supabase';
import { writeAudit } from '$lib/server/audit';

export async function GET({ cookies }) {
	const user = await requireUser(cookies);
	return json({ user });
}

export async function POST({ request, cookies }) {
	const user = await requireUser(cookies);
	const body = await request.json().catch(() => ({}));
	const action = String(body.action ?? '');
	const supabase = getSupabaseAdmin();

	if (action === 'profile.update') {
		const displayName = String(body.displayName ?? '').trim();
		const email = String(body.email ?? '').trim().toLowerCase() || null;
		if (displayName.length < 2 || displayName.length > 80) return json({ error: 'Display name must be 2-80 characters' }, { status: 400 });
		if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address' }, { status: 400 });
		if (email) {
			const { data: duplicate } = await supabase.from('orbitfs_users').select('id').ilike('email', email).neq('id', user.id).maybeSingle();
			if (duplicate) return json({ error: 'That email is already in use' }, { status: 409 });
		}
		const { data, error } = await supabase.from('orbitfs_users').update({ display_name: displayName, email }).eq('id', user.id).select('id,username,display_name,email,role,status,avatar_url').single();
		if (error) return json({ error: error.message }, { status: 500 });
		await writeAudit({ actorUserId: user.id, action, targetType: 'user', targetId: user.id });
		return json({ ok: true, user: data });
	}

	if (action === 'password.change') {
		const currentPassword = String(body.currentPassword ?? '');
		const newPassword = String(body.newPassword ?? '');
		if (newPassword.length < 8 || newPassword.length > 128 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) return json({ error: 'New password must be 8-128 characters and include a letter and number' }, { status: 400 });
		const { data: row, error: lookupError } = await supabase.from('orbitfs_users').select('password_hash').eq('id', user.id).single();
		if (lookupError || !row || !verifyPassword(currentPassword, row.password_hash)) return json({ error: 'Current password is incorrect', code: 'CURRENT_PASSWORD_INCORRECT' }, { status: 400 });
		const { error } = await supabase.from('orbitfs_users').update({ password_hash: hashPassword(newPassword) }).eq('id', user.id);
		if (error) return json({ error: error.message }, { status: 500 });
		await writeAudit({ actorUserId: user.id, action, targetType: 'user', targetId: user.id });
		return json({ ok: true });
	}

	return json({ error: 'Unknown account action' }, { status: 400 });
}
