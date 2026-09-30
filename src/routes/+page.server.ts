import { redirect } from '@sveltejs/kit';
import { getSessionUser } from '$lib/server/auth';

export async function load({ cookies }) {
	const user = await getSessionUser(cookies);
	throw redirect(303, user ? '/engines' : '/login');
}
