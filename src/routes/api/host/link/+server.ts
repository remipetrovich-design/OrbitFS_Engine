import { json } from '@sveltejs/kit';
import { authorizeEngineHostRequest } from '$lib/server/engine-host-link';
import { getSharedEngineHostState, linkSharedEngineHost, touchSharedEngineHostHealth, unlinkSharedEngineHost } from '$lib/server/shared-engine-host';

const deny = () => json({ error: 'Not found' }, { status: 404 });

function signed(request: Request, rawBody = '') {
	if (!request.headers.get('x-orbitfs-timestamp') || !request.headers.get('x-orbitfs-signature')) return false;
	return authorizeEngineHostRequest(request, rawBody);
}

function failure(error: any) {
	return json({ error: String(error?.message || 'Shared Engine Host link failed'), code: String(error?.code || 'ENGINE_HOST_LINK_FAILED') }, {
		status: Number(error?.status || 500),
		headers: { 'cache-control': 'no-store' }
	});
}

export async function GET({ request }) {
	if (!signed(request)) return deny();
	try {
		const state = await touchSharedEngineHostHealth();
		return json({ ok: true, state }, { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return failure(error);
	}
}

export async function POST({ request }) {
	const rawBody = await request.text();
	if (!signed(request, rawBody)) return deny();
	try {
		const body = rawBody ? JSON.parse(rawBody) : {};
		const action = String(body.action || 'link').trim().toLowerCase();
		if (!['link','sync'].includes(action)) return json({ error: 'Invalid Shared Engine Host action', code: 'ENGINE_HOST_ACTION_INVALID' }, { status: 400 });
		const state = await linkSharedEngineHost(body);
		return json({ ok: true, action, state }, { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return failure(error);
	}
}

export async function DELETE({ request }) {
	const rawBody = await request.text();
	if (!signed(request, rawBody)) return deny();
	try {
		const body = rawBody ? JSON.parse(rawBody) : {};
		const current = await getSharedEngineHostState();
		if (body.installationId && String(body.installationId) !== current.installationId) {
			return json({ error: 'Installation mismatch', code: 'INSTALLATION_MISMATCH' }, { status: 409 });
		}
		const state = await unlinkSharedEngineHost(String(body.actorUserId || '').trim() || null);
		return json({ ok: true, action: 'unlink', state }, { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return failure(error);
	}
}
