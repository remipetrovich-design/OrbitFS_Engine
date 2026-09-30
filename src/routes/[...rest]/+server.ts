import type { RequestHandler } from './$types';

const hidden: RequestHandler = () =>
	new Response(null, {
		status: 404,
		headers: {
			'cache-control': 'no-store',
			'x-robots-tag': 'noindex, nofollow, noarchive'
		}
	});

export const GET = hidden;
export const HEAD = hidden;
