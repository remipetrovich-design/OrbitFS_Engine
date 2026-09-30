import { json } from '@sveltejs/kit';
import { assertAddonEngineLicensed } from '$lib/server/addon-engine';
import {
	authorizeEngineHostRequest,
	detachEngineHost,
	getEngineHostLink,
	pairEngineHost
} from '$lib/server/engine-host-link';

const deny = () => json({ error: 'Not found' }, { status: 404 });

function authorizeSignedPairingRequest(request: Request, rawBody = '') {
	const timestamp = String(request.headers.get('x-orbitfs-timestamp') || '').trim();
	const signature = String(request.headers.get('x-orbitfs-signature') || '').trim();
	if (!timestamp || !signature) return false;
	return authorizeEngineHostRequest(request, rawBody);
}

function failure(error: any, fallback: string) {
	return json(
		{
			error: String(error?.message || fallback),
			code: String(error?.code || 'ENGINE_LINK_FAILED')
		},
		{ status: Number(error?.status || 500), headers: { 'cache-control': 'no-store' } }
	);
}

export async function GET({ request, url }) {
	if (!authorizeSignedPairingRequest(request)) return deny();
	try {
		const engineId = url.searchParams.get('engine') || url.searchParams.get('engineId') || '';
		await assertAddonEngineLicensed(engineId);
		return json(await getEngineHostLink(engineId), { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return failure(error, 'Engine link status failed');
	}
}

export async function POST({ request }) {
	const rawBody = await request.text();
	if (!authorizeSignedPairingRequest(request, rawBody)) return deny();
	try {
		const body = rawBody ? JSON.parse(rawBody) : {};
		const action = String(body.action || 'pair').trim().toLowerCase();
		if (action === 'detach') {
			const state = await detachEngineHost(body.engineId || body.engine_id, body.actorUserId || body.actor_user_id || null);
			return json({ ok: true, action, state }, { headers: { 'cache-control': 'no-store' } });
		}
		if (!['pair', 'attach', 'sync'].includes(action)) {
			return json({ error: 'Invalid Engine Host link action', code: 'ENGINE_LINK_ACTION_INVALID' }, { status: 400 });
		}
		const engineId = String(body.engineId || body.engine_id || '').trim();
		await assertAddonEngineLicensed(engineId);
		const attached = action === 'sync' ? body.attached !== false : true;
		const state = await pairEngineHost({ ...body, attached });
		return json({ ok: true, action, state }, { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return failure(error, 'Engine Host pairing failed');
	}
}

export async function DELETE({ request, url }) {
	if (!authorizeSignedPairingRequest(request)) return deny();
	try {
		const engineId = url.searchParams.get('engine') || url.searchParams.get('engineId') || '';
		const actorUserId = url.searchParams.get('actorUserId');
		const state = await detachEngineHost(engineId, actorUserId);
		return json({ ok: true, action: 'detach', state }, { headers: { 'cache-control': 'no-store' } });
	} catch (error: any) {
		return failure(error, 'Engine Host detach failed');
	}
}
