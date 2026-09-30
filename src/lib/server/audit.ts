import { getSupabaseAdmin } from '$lib/server/supabase';

export async function writeAudit(input: {
	actorUserId?: string | null;
	workspaceId?: string | null;
	action: string;
	targetType: string;
	targetId?: string | null;
	detail?: Record<string, unknown>;
	ip?: string | null;
	userAgent?: string | null;
}) {
	const supabase = getSupabaseAdmin();
	await supabase.from('orbitfs_audit_log').insert({
		actor_user_id: input.actorUserId ?? null,
		workspace_id: input.workspaceId ?? null,
		action: input.action,
		target_type: input.targetType,
		target_id: input.targetId ?? null,
		detail: input.detail ?? {},
		ip_address: input.ip ?? null,
		user_agent: input.userAgent ?? null
	});
}
