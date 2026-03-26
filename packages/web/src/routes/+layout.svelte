<script lang="ts">
	import "../app.css";
	import { auth } from "$lib/stores/auth.svelte.js";
	import Balance from "../components/balance.svelte";
	import ConnectionStatus from "../components/connection-status.svelte";
	let { children } = $props();
</script>

<div class="min-h-screen bg-background">
	<header class="border-b border-border px-4 py-3">
		<div class="mx-auto flex max-w-2xl items-center justify-between">
			<h1 class="text-lg font-semibold text-foreground">WPM</h1>
			<div class="flex items-center gap-3">
				{#if auth.isLoggedIn}
					<Balance />
				{/if}
				<ConnectionStatus />
			</div>
		</div>
	</header>
	<main class="mx-auto max-w-2xl px-4 py-6">
		{@render children()}
	</main>
</div>
