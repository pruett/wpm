<script lang="ts">
	import "../app.css";
	import { goto } from "$app/navigation";
	import { dev } from "$app/environment";
	import { authClient } from "$lib/auth-client.js";
	import { session } from "$lib/stores/auth.svelte.js";
	import Balance from "../components/balance.svelte";
	import ConnectionStatus from "../components/connection-status.svelte";
	// DEV-PERSONAS: remove this import and the {#if dev} block below to disable.
	import DevPersonaSwitcher from "$lib/dev-personas/switcher.svelte";

	let { children } = $props();

	async function logout() {
		await authClient.signOut();
		goto("/login");
	}
</script>

<div class="min-h-screen bg-background">
	<header class="border-b border-border px-4 py-3">
		<div class="mx-auto flex max-w-2xl items-center justify-between">
			<h1 class="text-lg font-semibold text-foreground">WPM</h1>
			<div class="flex items-center gap-3">
				{#if $session?.data?.user}
					<Balance />
					<button
						onclick={logout}
						class="text-sm text-muted-foreground hover:text-foreground"
					>
						Logout
					</button>
				{/if}
				<ConnectionStatus />
			</div>
		</div>
	</header>
	<main class="mx-auto max-w-2xl px-4 py-6">
		{@render children()}
	</main>
</div>

<!-- DEV-PERSONAS: remove this block to disable browser persona switching. -->
{#if dev}
	<DevPersonaSwitcher />
{/if}
