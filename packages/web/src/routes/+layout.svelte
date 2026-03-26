<script lang="ts">
	import "../app.css";
	let { children } = $props();
</script>

<div class="min-h-screen bg-background">
	<header class="border-b border-border px-4 py-3">
		<h1 class="text-lg font-semibold text-foreground">WPM</h1>
	</header>
	<main class="mx-auto max-w-2xl px-4 py-6">
		{@render children()}
	</main>
</div>
