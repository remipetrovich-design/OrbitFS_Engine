import { fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { getLicenseProviderDiagnostics, getLicenseProviderSettings, setLicenseProviderBase } from '$lib/server/license';

export async function load({ cookies }) {
	await requireAdmin(cookies);
	return { connection: await getLicenseProviderSettings() };
}

export const actions = {
	save: async ({ request, cookies }) => {
		await requireAdmin(cookies);
		const form = await request.formData();
		try {
			const connection = await setLicenseProviderBase(String(form.get('providerBase') || ''));
			return { ok: true, action: 'save', connection, message: 'Official OrbitFS licence API selected.' };
		} catch (error: any) {
			return fail(Number(error?.status || 400), { ok: false, action: 'save', error: String(error?.message || 'Could not save API connection') });
		}
	},
	test: async ({ request, cookies }) => {
		await requireAdmin(cookies);
		const form = await request.formData();
		try {
			const diagnostics = await getLicenseProviderDiagnostics(String(form.get('providerBase') || '').trim() || undefined);
			return { ok: Boolean(diagnostics?.master?.ok), action: 'test', diagnostics, message: diagnostics?.master?.ok ? 'Official API connection is reachable.' : undefined, error: diagnostics?.master?.ok ? undefined : String(diagnostics?.master?.error || 'Connection test failed') };
		} catch (error: any) {
			return fail(Number(error?.status || 400), { ok: false, action: 'test', error: String(error?.message || 'API connection test failed') });
		}
	}
};
