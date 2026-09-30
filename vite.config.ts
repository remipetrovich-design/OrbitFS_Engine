import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// OAuth token exchange is a server-to-server form POST. Route-specific
			// CSRF protection is enforced in hooks.server.ts for normal web forms.
			csrf: { trustedOrigins: ['*'] }
		})
	]
});
