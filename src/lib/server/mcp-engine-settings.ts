import { getSupabaseAdmin } from '$lib/server/supabase';

export type McpEngineSettings = {
	version: 1;
	accessTokenMinutes: number;
	refreshTokenDays: number;
	authorizationCodeMinutes: number;
	allowWriteScope: boolean;
	allowOfflineAccess: boolean;
	dynamicClientRegistration: boolean;
	maxRequestKb: number;
	requireJsonContentType: boolean;
	allowDeleteTransport: boolean;
	mirrorUiState: boolean;
	logRejectedRequests: boolean;
	updatedAt: string | null;
	updatedByUserId: string | null;
};

const SETTING_KEY = 'mcp.engine.settings';
const CACHE_MS = 10_000;
let cached: { expiresAt:number; value:McpEngineSettings } | null = null;
let loading: Promise<McpEngineSettings> | null = null;

const DEFAULTS: McpEngineSettings = {
	version: 1,
	accessTokenMinutes: 60,
	refreshTokenDays: 30,
	authorizationCodeMinutes: 10,
	allowWriteScope: true,
	allowOfflineAccess: true,
	dynamicClientRegistration: true,
	maxRequestKb: 1024,
	requireJsonContentType: true,
	allowDeleteTransport: true,
	mirrorUiState: true,
	logRejectedRequests: true,
	updatedAt: null,
	updatedByUserId: null
};

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function bounded(value: unknown, fallback: number, min: number, max: number) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.round(Math.min(max, Math.max(min, number)));
}

function booleanValue(value: unknown, fallback: boolean) {
	return typeof value === 'boolean' ? value : fallback;
}

function normalize(value: unknown): McpEngineSettings {
	const raw = objectValue(value);
	return {
		version: 1,
		accessTokenMinutes: bounded(raw.accessTokenMinutes, DEFAULTS.accessTokenMinutes, 5, 1440),
		refreshTokenDays: bounded(raw.refreshTokenDays, DEFAULTS.refreshTokenDays, 1, 90),
		authorizationCodeMinutes: bounded(raw.authorizationCodeMinutes, DEFAULTS.authorizationCodeMinutes, 1, 30),
		allowWriteScope: booleanValue(raw.allowWriteScope, DEFAULTS.allowWriteScope),
		allowOfflineAccess: booleanValue(raw.allowOfflineAccess, DEFAULTS.allowOfflineAccess),
		dynamicClientRegistration: booleanValue(raw.dynamicClientRegistration, DEFAULTS.dynamicClientRegistration),
		maxRequestKb: bounded(raw.maxRequestKb, DEFAULTS.maxRequestKb, 64, 16384),
		requireJsonContentType: booleanValue(raw.requireJsonContentType, DEFAULTS.requireJsonContentType),
		allowDeleteTransport: booleanValue(raw.allowDeleteTransport, DEFAULTS.allowDeleteTransport),
		mirrorUiState: booleanValue(raw.mirrorUiState, DEFAULTS.mirrorUiState),
		logRejectedRequests: booleanValue(raw.logRejectedRequests, DEFAULTS.logRejectedRequests),
		updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
		updatedByUserId: raw.updatedByUserId ? String(raw.updatedByUserId) : null
	};
}

async function loadMcpEngineSettings(): Promise<McpEngineSettings> {
	const db = getSupabaseAdmin();
	const result = await db.from('orbitfs_settings').select('value')
		.eq('scope_type', 'global').eq('scope_id', '').eq('key', SETTING_KEY).maybeSingle();
	if (result.error) throw result.error;
	const value=normalize(result.data?.value);
	cached={expiresAt:Date.now()+CACHE_MS,value};
	return value;
}

export async function getMcpEngineSettings(force=false): Promise<McpEngineSettings> {
	if(!force&&cached&&cached.expiresAt>Date.now())return cached.value;
	if(!force&&loading)return loading;
	loading=loadMcpEngineSettings();
	try{return await loading;}finally{loading=null;}
}

export async function saveMcpEngineSettings(input: Partial<McpEngineSettings>, actorUserId: string) {
	const current = await getMcpEngineSettings();
	const stamp = new Date().toISOString();
	const next = normalize({ ...current, ...input, updatedAt: stamp, updatedByUserId: actorUserId });
	const db = getSupabaseAdmin();
	const result = await db.from('orbitfs_settings').upsert({
		scope_type: 'global', scope_id: '', key: SETTING_KEY, value: next, updated_at: stamp
	}, { onConflict: 'scope_type,scope_id,key' });
	if (result.error) throw result.error;
	cached={expiresAt:Date.now()+CACHE_MS,value:next};
	return next;
}
