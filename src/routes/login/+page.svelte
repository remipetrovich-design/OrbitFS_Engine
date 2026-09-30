<script lang="ts">
	let { form } = $props();
</script>

<svelte:head><title>Sign in · OrbitFS Engine Host</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<div class="login">
	<main>
		<header><small>ORBITFS</small><h1>Engine Host</h1><p>Sign in with your OrbitFS Panel account.</p></header>
		<form method="POST">
			<label><span>Username or email</span><input name="identity" autocomplete="username" value={form?.identity || ''} required /></label>
			<label><span>Password</span><input name="credential" type="password" autocomplete="current-password" required /></label>
			{#if form?.error}<div class="error">{form.error}</div>{/if}
			<button type="submit">Sign in</button>
		</form>
		<footer>No separate Engine account is created.</footer>
	</main>
</div>

<style>
	.login{min-height:100vh;display:grid;place-items:center;padding:18px;background:#050505}.login main{width:min(100%,410px);border:1px solid #292929;background:#0a0a0a;padding:22px}.login header{border-bottom:1px solid #252525;padding-bottom:15px;margin-bottom:16px}.login header small{font-size:8px;color:#777;letter-spacing:.14em}.login h1{font-size:24px;margin:3px 0 5px}.login p{margin:0;color:#888;font-size:11px}.login form{display:grid;gap:13px}.login label{display:grid;gap:5px}.login label span{font-size:9px;color:#aaa}.login input{width:100%;background:#070707;border:1px solid #333;color:#eee;padding:10px;font:inherit;font-size:11px}.login button{background:#e5e5e5;border:1px solid #e5e5e5;color:#080808;padding:10px;font-size:10px;font-weight:750;cursor:pointer}.error{border:1px solid #662a2a;background:#140909;color:#e6a7a7;padding:9px;font-size:10px}.login footer{border-top:1px solid #252525;margin-top:16px;padding-top:12px;color:#666;font-size:8px;text-align:center}
</style>
