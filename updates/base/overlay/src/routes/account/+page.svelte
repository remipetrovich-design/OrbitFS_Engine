<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { auth } from '$lib/auth.svelte';
	import { Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Button, Input } from '$lib/components/ui';
	import { CircleUser, Mail, Lock, LoaderCircle, Save, Folder, Bell } from '@lucide/svelte';

	type Profile = {
		username: string;
		email: string | null;
		role: 'owner' | 'owner' | 'admin' | 'user';
		owned_workspaces?: number;
		workspace_memberships?: number;
		active_sessions?: number;
	};

	let profile = $state<Profile | null>(null);
	let loading = $state(true);
	let error = $state('');

	let email = $state('');
	let emailSaving = $state(false);
	let emailError = $state('');
	let emailSaved = $state(false);

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let passwordSaving = $state(false);
	let passwordError = $state('');
	let passwordSaved = $state(false);

	async function load() {
		loading = true;
		error = '';
		try {
			const res = await api.get<{ user: Profile }>('/me');
			profile = res.user;
			email = res.user.email ?? '';
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Failed to load profile';
		} finally {
			loading = false;
		}
	}
	load();

	async function saveEmail(e: Event) {
		e.preventDefault();
		emailSaving = true;
		emailError = '';
		emailSaved = false;
		try {
			const res = await api.patch<{ user: Profile }>('/me', { email });
			profile = res.user;
			auth.setUser({ username: res.user.username, role: res.user.role, email: res.user.email ?? undefined });
			emailSaved = true;
		} catch (err) {
			emailError = err instanceof ApiError ? err.message : 'Save failed';
		} finally {
			emailSaving = false;
		}
	}

	async function savePassword(e: Event) {
		e.preventDefault();
		passwordError = '';
		passwordSaved = false;
		if (!currentPassword) {
			passwordError = 'Enter your current password';
			return;
		}
		if (newPassword.length < 8 || newPassword.length > 128 || !/[A-Za-z]/.test(newPassword) || !/\\d/.test(newPassword)) {
			passwordError = 'Password must be 8-128 characters and include a letter and number';
			return;
		}
		if (newPassword !== confirmPassword) {
			passwordError = "Passwords don't match";
			return;
		}
		passwordSaving = true;
		try {
			await api.post('/account', { action: 'password.change', currentPassword, newPassword });
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
			passwordSaved = true;
		} catch (err) {
			passwordError = err instanceof ApiError ? err.message : 'Password update failed';
		} finally {
			passwordSaving = false;
		}
	}

</script>

<div class="mx-auto max-w-xl space-y-6 p-4 md:p-6">
	<div>
		<h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
			<CircleUser class="size-5 text-muted-foreground" />
			User control panel
		</h1>
		<p class="text-sm text-muted-foreground">Your account, access and security controls.</p>
	</div>

	{#if error}
		<div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{error}
		</div>
	{/if}

	{#if loading}
		<div class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
			<LoaderCircle class="size-5 animate-spin" />
			Loading&hellip;
		</div>
	{:else if profile}
		<Card>
			<CardHeader>
				<div class="flex items-center justify-between">
					<CardTitle>{profile.username}</CardTitle>
					<Badge variant={profile.role === 'owner' ? 'success' : profile.role === 'admin' ? 'default' : 'secondary'}>{profile.role}</Badge>
				</div>
			</CardHeader>
			{#if profile.owned_workspaces != null}
				<CardContent class="flex gap-6 text-sm text-muted-foreground">
					<span>{profile.owned_workspaces} owned workspaces</span>
					<span>{profile.workspace_memberships} memberships</span>
					<span>{profile.active_sessions} active sessions</span>
				</CardContent>
			{/if}
		</Card>

		<div class="grid gap-3 sm:grid-cols-2">
			<a href="/" class="rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent/40">
				<div class="flex items-center gap-2 font-medium"><Folder class="size-4" />Files</div>
				<p class="mt-1 text-xs text-muted-foreground">Open files you have permission to access.</p>
			</a>
			<a href="/notifications" class="rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent/40">
				<div class="flex items-center gap-2 font-medium"><Bell class="size-4" />Notifications</div>
				<p class="mt-1 text-xs text-muted-foreground">Review account and storage updates.</p>
			</a>
		</div>

		<Card>
			<CardHeader>
				<CardTitle class="flex items-center gap-2">
					<Mail class="size-4 text-muted-foreground" />
					Email
				</CardTitle>
			</CardHeader>
			<CardContent>
				<form class="flex flex-wrap items-end gap-2" onsubmit={saveEmail}>
					<Input type="email" bind:value={email} placeholder="you@example.com" class="max-w-xs flex-1" />
					<Button type="submit" size="sm" disabled={emailSaving}>
						{#if emailSaving}<LoaderCircle class="size-4 animate-spin" />{:else}<Save />{/if}
						Save
					</Button>
				</form>
				{#if emailError}<p class="mt-2 text-sm text-destructive">{emailError}</p>{/if}
				{#if emailSaved}<p class="mt-2 text-sm text-success">Saved.</p>{/if}
			</CardContent>
		</Card>

		<Card>
			<CardHeader>
				<CardTitle class="flex items-center gap-2">
					<Lock class="size-4 text-muted-foreground" />
					Change password
				</CardTitle>
				<CardDescription>8-128 characters, including a letter and a number.</CardDescription>
			</CardHeader>
			<CardContent>
				<form class="space-y-3" onsubmit={savePassword}>
					<div class="space-y-1.5">
						<label for="current-password" class="text-sm font-medium">Current password</label>
						<Input id="current-password" type="password" autocomplete="current-password" bind:value={currentPassword} required />
					</div>
					<div class="grid gap-3 sm:grid-cols-2">
						<div class="space-y-1.5">
							<label for="new-password" class="text-sm font-medium">New password</label>
							<Input id="new-password" type="password" autocomplete="new-password" bind:value={newPassword} minlength={8} maxlength={128} required />
						</div>
						<div class="space-y-1.5">
							<label for="confirm-password" class="text-sm font-medium">Confirm password</label>
							<Input id="confirm-password" type="password" autocomplete="new-password" bind:value={confirmPassword} minlength={8} maxlength={128} required />
						</div>
					</div>
					{#if passwordError}<p class="text-sm text-destructive">{passwordError}</p>{/if}
					{#if passwordSaved}<p class="text-sm text-success">Password updated.</p>{/if}
					<Button type="submit" size="sm" disabled={passwordSaving}>
						{#if passwordSaving}<LoaderCircle class="size-4 animate-spin" />{:else}<Save />{/if}
						Update password
					</Button>
				</form>
			</CardContent>
		</Card>
	{/if}
</div>
