import { json } from '@sveltejs/kit';

export async function GET() {
	return json(
		{ ok: true, service: 'orbitfs-engine-host', version: '1.5.0' },
		{ headers: { 'cache-control': 'no-store' } }
	);
}
