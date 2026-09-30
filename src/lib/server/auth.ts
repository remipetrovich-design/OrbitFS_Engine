import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { error, type Cookies } from '@sveltejs/kit';
import { getSupabaseAdmin } from '$lib/server/supabase';

const COOKIE = 'orbitfs_session';
const SESSION_DAYS = 30;
const HEARTBEAT_INTERVAL_MS = 60_000;
const heartbeatCache = new Map<string, number>();

export type OrbitUser = {
	id: string;
	username: string;
	display_name: string;
	email: string | null;
	role: 'owner' | 'admin' | 'user';
	status: 'active' | 'inactive' | 'banned';
	avatar_url: string | null;
	permissions?: Record<string, boolean>;
	must_change_pin?: boolean;
	ban_reason?: string | null;
};

export function hashPassword(password: string) {
	const salt = randomBytes(16).toString('hex');
	const hash = scryptSync(password, salt, 64).toString('hex');
	return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, encoded: string) {
	const [scheme, salt, expectedHex] = encoded.split('$');
	if (scheme !== 'scrypt' || !salt || !expectedHex) return false;
	const actual = scryptSync(password, salt, 64);
	const expected = Buffer.from(expectedHex, 'hex');
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function authenticateOrbitCredentials(identity: string, credential: string) {
	const value = String(identity || '').trim();
	if (!value || !credential) return null;
	const supabase = getSupabaseAdmin();
	const query = supabase.from('orbitfs_users').select('id,username,display_name,email,password_hash,role,status,avatar_url,permissions,must_change_pin,ban_reason,login_count');
	const { data: user, error: dbError } = value.includes('@')
		? await query.ilike('email', value.toLowerCase()).maybeSingle()
		: await query.ilike('username', value).maybeSingle();
	if (dbError) throw dbError;
	if (!user || !verifyPassword(credential, String(user.password_hash || ''))) return null;
	return user;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const seenMs = (value: unknown) => {
	const parsed = Date.parse(String(value || ''));
	return Number.isFinite(parsed) ? parsed : 0;
};

function heartbeatDue(key: string, stored: unknown, now: number) {
	const last = Math.max(heartbeatCache.get(key) || 0, seenMs(stored));
	if (now - last < HEARTBEAT_INTERVAL_MS) return false;
	heartbeatCache.set(key, now);
	return true;
}

export async function createSession(
	userId: string,
	cookies: Cookies,
	meta: { userAgent?: string | null; ip?: string | null; secure?: boolean } = {}
) {
	const supabase = getSupabaseAdmin();
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
	const { error: dbError } = await supabase.from('orbitfs_sessions').insert({
		user_id: userId,
		token_hash: hashToken(token),
		user_agent: meta.userAgent ?? null,
		ip_address: meta.ip ?? null,
		expires_at: expiresAt
	});
	if (dbError) throw dbError;
	cookies.set(COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: meta.secure ?? true,
		maxAge: SESSION_DAYS * 86400
	});
	return token;
}

export async function getSessionUser(cookies: Cookies): Promise<OrbitUser | null> {
	const token = cookies.get(COOKIE);
	if (!token) return null;
	const supabase = getSupabaseAdmin();
	const { data: session } = await supabase
		.from('orbitfs_sessions')
		.select('id,user_id,expires_at,last_seen_at')
		.eq('token_hash', hashToken(token))
		.maybeSingle();
	if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
		cookies.delete(COOKIE, { path: '/' });
		return null;
	}
	const { data: user } = await supabase
		.from('orbitfs_users')
		.select('id,username,display_name,email,role,status,avatar_url,permissions,must_change_pin,ban_reason,last_login_at,last_seen_at,login_count')
		.eq('id', session.user_id)
		.maybeSingle();
	if (!user || user.status !== 'active') return null;

	const stampMs = Date.now();
	const stamp = new Date(stampMs).toISOString();
	if (heartbeatDue(`session:${session.id}`, session.last_seen_at, stampMs)) {
		void supabase.from('orbitfs_sessions').update({ last_seen_at: stamp }).eq('id', session.id).then(() => undefined, () => undefined);
	}
	if (heartbeatDue(`user:${user.id}`, user.last_seen_at, stampMs)) {
		void supabase.from('orbitfs_users').update({ last_seen_at: stamp }).eq('id', user.id).then(() => undefined, () => undefined);
	}
	return user as OrbitUser;
}

export async function requireUser(cookies: Cookies) {
	const user = await getSessionUser(cookies);
	if (!user) throw error(401, 'Authentication required');
	return user;
}

export async function requireAdmin(cookies: Cookies) {
	const user = await requireUser(cookies);
	if (!['owner', 'admin'].includes(user.role)) throw error(403, 'Administrator access required');
	return user;
}

export async function destroySession(cookies: Cookies) {
	const token = cookies.get(COOKIE);
	if (token) {
		const supabase = getSupabaseAdmin();
		await supabase.from('orbitfs_sessions').delete().eq('token_hash', hashToken(token));
	}
	cookies.delete(COOKIE, { path: '/' });
}
