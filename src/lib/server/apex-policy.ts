import { getSupabaseAdmin } from '$lib/server/supabase';

export const APEX_POLICY_DEFAULTS = {
	serviceMode: 'on_demand' as 'on_demand' | 'automatic',
	fullShutdown: false,
	standby: true,
	forceManualScan: true,
	blockAutomation: false,
	idleTimeoutMs: 10_000,
	eventDriven: true
};

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export async function getApexExecutionPolicy() {
	const db = getSupabaseAdmin();
	const result = await db.from('orbitfs_settings').select('value')
		.eq('scope_type', 'global').eq('scope_id', '').eq('key', 'apex.cloud.policy').maybeSingle();
	if (result.error) throw result.error;
	const raw = objectValue(result.data?.value);
	return {
		...APEX_POLICY_DEFAULTS,
		...raw,
		serviceMode: raw.serviceMode === 'automatic' ? 'automatic' as const : 'on_demand' as const,
		fullShutdown: raw.fullShutdown === true,
		standby: raw.standby !== false,
		forceManualScan: true,
		blockAutomation: raw.blockAutomation === true,
		idleTimeoutMs: Math.max(5_000, Math.min(300_000, Number(raw.idleTimeoutMs || APEX_POLICY_DEFAULTS.idleTimeoutMs))),
		eventDriven: true
	};
}

export async function saveApexExecutionPolicy(input: Record<string, any> = {}) {
	const current = await getApexExecutionPolicy();
	const next = {
		...current,
		serviceMode: input.serviceMode === 'automatic' ? 'automatic' as const : 'on_demand' as const,
		fullShutdown: input.fullShutdown === true,
		standby: input.standby !== false,
		forceManualScan: true,
		blockAutomation: input.blockAutomation === true,
		idleTimeoutMs: Math.max(5_000, Math.min(300_000, Number(input.idleTimeoutMs || current.idleTimeoutMs))),
		eventDriven: true
	};
	const db = getSupabaseAdmin();
	const result = await db.from('orbitfs_settings').upsert({
		scope_type: 'global', scope_id: '', key: 'apex.cloud.policy', value: next, updated_at: new Date().toISOString()
	}, { onConflict: 'scope_type,scope_id,key' });
	if (result.error) throw result.error;
	return next;
}
