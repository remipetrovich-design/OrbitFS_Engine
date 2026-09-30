import { hashPassword } from '$lib/server/auth';
import { getSupabaseAdmin } from '$lib/server/supabase';

export const USER_CAPABILITIES = [
	'create_workspaces','access_public_workspace','invite_workspace_members','share_files',
	'mcp_use','mcp_manage_startup','mcp_manage_preset_names','mcp_manage_projects','mcp_manage_settings',
	'sorter_view','sorter_scan','sorter_add_to_queue','sorter_review_queue','sorter_apply','sorter_undo',
	'sorter_manage_rules','sorter_auto_apply','converter_view','converter_run','converter_manage_settings'
] as const;

export const USER_CAPABILITY_LABELS: Record<string,string> = {
	create_workspaces:'Create workspaces', access_public_workspace:'Access public workspace', invite_workspace_members:'Invite workspace members', share_files:'Share files',
	mcp_use:'Use MCP', mcp_manage_startup:'Manage MCP startup', mcp_manage_preset_names:'Rename MCP startup presets', mcp_manage_projects:'Manage MCP projects', mcp_manage_settings:'Manage MCP settings',
	sorter_view:'View Sorter', sorter_scan:'Run Sorter scan', sorter_add_to_queue:'Add to Sorter queue', sorter_review_queue:'Review Sorter queue', sorter_apply:'Apply Sorter changes', sorter_undo:'Undo Sorter changes', sorter_manage_rules:'Manage Sorter rules', sorter_auto_apply:'Allow Sorter auto-apply',
	converter_view:'View Converter', converter_run:'Run Converter', converter_manage_settings:'Manage Converter settings'
};

export const REGISTRATION_MODES = ['off','open','approval_queue'] as const;
export type RegistrationMode = typeof REGISTRATION_MODES[number];

export const REGISTERED_USER_PERMISSION_DEFAULTS = {
	create_workspaces: true, access_public_workspace: true,
	invite_workspace_members: false, share_files: false,
	mcp_use: true, mcp_manage_startup: false, mcp_manage_preset_names: false,
	mcp_manage_projects: false, mcp_manage_settings: false,
	sorter_view: true, sorter_scan: true, sorter_add_to_queue: true,
	sorter_review_queue: false, sorter_apply: false, sorter_undo: false,
	sorter_manage_rules: false, sorter_auto_apply: false,
	converter_view: true, converter_run: true, converter_manage_settings: false
};
export function normalizeUserPermissions(input: any = {}, fallback: any = REGISTERED_USER_PERMISSION_DEFAULTS) {
	return Object.fromEntries(USER_CAPABILITIES.map((key) => [key, Boolean(input?.[key] ?? fallback?.[key] ?? false)]));
}

export type RegistrationSettings = {
	mode: RegistrationMode;
	modes: RegistrationMode[];
	defaultRole: 'user';
	defaultPermissions: Record<string, boolean>;
	pendingRequests: any[];
};

export async function readRegistrationSettings(includeRequests = true): Promise<RegistrationSettings> {
	const supabase = getSupabaseAdmin();
	const { data, error } = await supabase.from('orbitfs_settings').select('value')
		.eq('scope_type','global').eq('scope_id','').eq('key','registration').maybeSingle();
	if (error) throw error;
	const current: any = data?.value && typeof data.value === 'object' ? data.value : {};
	const mode: RegistrationMode = REGISTRATION_MODES.includes(current.mode) ? current.mode : 'off';
	let pendingRequests: any[] = [];
	if (includeRequests) {
		const result = await supabase.from('orbitfs_registration_requests').select('*').eq('status','pending').order('requested_at');
		if (result.error) throw result.error;
		pendingRequests = (result.data ?? []).map(presentRegistrationRequest);
	}
	return { mode, modes: [...REGISTRATION_MODES], defaultRole: 'user', defaultPermissions: normalizeUserPermissions(current.defaultPermissions), pendingRequests };
}
export async function saveRegistrationSettings(input: any) {
	const current = await readRegistrationSettings(false);
	const mode = input?.mode !== undefined && REGISTRATION_MODES.includes(String(input.mode) as RegistrationMode)
		? String(input.mode) as RegistrationMode : current.mode;
	const defaultPermissions = input?.defaultPermissions
		? normalizeUserPermissions(input.defaultPermissions, current.defaultPermissions)
		: current.defaultPermissions;
	const value = { mode, defaultRole: 'user', defaultPermissions };
	const supabase = getSupabaseAdmin();
	const { error } = await supabase.from('orbitfs_settings').upsert({
		scope_type:'global', scope_id:'', key:'registration', value
	}, { onConflict:'scope_type,scope_id,key' });
	if (error) throw error;
	return readRegistrationSettings(true);
}

export function presentRegistrationRequest(row: any) {
	return {
		id: row.id,
		username: row.username,
		email: row.email ?? null,
		status: row.status,
		requestedAt: row.requested_at,
		approvedAt: row.status === 'approved' ? row.decided_at : null,
		rejectedAt: row.status === 'rejected' ? row.decided_at : null
	};
}
function validatePassword(password: string, username: string, email: string) {
	if (password.length < 8 || password.length > 128) throw Object.assign(new Error('Password must be 8-128 characters'), { status: 400 });
	if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw Object.assign(new Error('Password must include at least one letter and one number'), { status: 400 });
	const lower = password.toLowerCase();
	if (lower.includes(username.toLowerCase())) throw Object.assign(new Error('Password cannot include the username'), { status: 400 });
	const emailName = email.split('@')[0]?.toLowerCase();
	if (emailName && emailName.length >= 3 && lower.includes(emailName)) throw Object.assign(new Error('Password cannot include the email name'), { status: 400 });
}

function validatePin(pin: string) {
	if (!/^\d{8}$/.test(pin)) throw Object.assign(new Error('PIN must be exactly 8 digits'), { status: 400 });
	if (/^(\d)\1{7}$/.test(pin) || ['12345678','87654321','00000000'].includes(pin)) throw Object.assign(new Error('Choose a less predictable 8-digit PIN'), { status: 400 });
}

export function validateAccountInput(body: any = {}) {
	const username = String(body.username ?? '').trim();
	const email = String(body.email ?? '').trim().toLowerCase();
	const password = String(body.password ?? '');
	const pin = String(body.pin ?? '');
	if (!/^(?!.*[._-]{2})[a-zA-Z0-9][a-zA-Z0-9._-]{1,30}[a-zA-Z0-9]$/.test(username)) throw Object.assign(new Error('Username must be 3-32 characters, start/end with a letter or number, and only use letters, numbers, dots, underscores, or dashes'), { status: 400 });
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw Object.assign(new Error('Enter a valid email address'), { status: 400 });
	if (password) { validatePassword(password, username, email); return { username, email, credentialHash: hashPassword(password), credentialType: 'password' as const }; }
	validatePin(pin);
	return { username, email, credentialHash: hashPassword(pin), credentialType: 'pin' as const };
}
export async function usernameAvailable(username: string, excludeRequestId = '') {
	const supabase = getSupabaseAdmin();
	const [existingUser, pending] = await Promise.all([
		supabase.from('orbitfs_users').select('id').ilike('username', username).maybeSingle(),
		supabase.from('orbitfs_registration_requests').select('id').ilike('username', username).eq('status','pending')
	]);
	if (existingUser.error) throw existingUser.error;
	if (pending.error) throw pending.error;
	return !existingUser.data && !(pending.data ?? []).some((item) => item.id !== excludeRequestId);
}

export async function createRegisteredUser(account: { username:string; email:string; credentialHash:string }, extra: any = {}) {
	const settings = await readRegistrationSettings(false);
	const supabase = getSupabaseAdmin();
	const { data, error } = await supabase.from('orbitfs_users').insert({
		username: account.username,
		display_name: account.username,
		email: account.email,
		password_hash: account.credentialHash,
		role: extra.role ?? 'user',
		status: extra.status ?? 'active',
		permissions: normalizeUserPermissions(extra.permissions ?? settings.defaultPermissions),
		must_change_pin: Boolean(extra.mustChangePin),
		ban_reason: extra.banReason ?? null
	}).select('id,username,display_name,email,role,status,avatar_url,permissions,must_change_pin,ban_reason').single();
	if (error || !data) throw error ?? new Error('Could not create user');
	return data;
}
export async function emailAvailable(email: string) {
	const supabase = getSupabaseAdmin();
	const { data, error } = await supabase.from('orbitfs_users').select('id').ilike('email', email).maybeSingle();
	if (error) throw error;
	return !data;
}

export async function queueRegistrationRequest(account: { username:string; email:string; credentialHash:string; credentialType:'password'|'pin' }) {
	const supabase = getSupabaseAdmin();
	const { data, error } = await supabase.from('orbitfs_registration_requests').insert({
		username: account.username,
		email: account.email,
		credential_hash: account.credentialHash,
		credential_type: account.credentialType,
		status: 'pending'
	}).select('*').single();
	if (error || !data) throw error ?? new Error('Could not queue registration');
	return presentRegistrationRequest(data);
}

export async function resolveRegistrationRequest(requestId: string, approve: boolean, actorId: string) {
	const supabase = getSupabaseAdmin();
	const { data: request, error } = await supabase.from('orbitfs_registration_requests').select('*').eq('id', requestId).eq('status','pending').maybeSingle();
	if (error) throw error;
	if (!request) throw Object.assign(new Error('Registration request not found'), { status: 404 });
	let created: any = null;
	if (approve) {
		if (!await usernameAvailable(request.username, request.id)) throw Object.assign(new Error('Username is no longer available'), { status: 409 });
		created = await createRegisteredUser({ username: request.username, email: request.email, credentialHash: request.credential_hash });
	}
	const { data: saved, error: updateError } = await supabase.from('orbitfs_registration_requests').update({
		status: approve ? 'approved' : 'rejected', decided_at: new Date().toISOString(), decided_by: actorId,
		created_user_id: created?.id ?? null
	}).eq('id', requestId).select('*').single();
	if (updateError) throw updateError;
	return { request: presentRegistrationRequest(saved), user: created };
}