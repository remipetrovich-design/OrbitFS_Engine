import { json } from '@sveltejs/kit';

// This legacy endpoint must not permit numeric PINs to overwrite account passwords.
// Existing users change their password via authenticated /api/account password.change.
export function POST() {
	return json({ error: 'PIN changes are no longer supported. Use the Account password settings.', code: 'PIN_CHANGE_RETIRED' }, { status: 410 });
}
