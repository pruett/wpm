<script lang="ts">
	import type { Snippet } from "svelte";
	import { marketStream } from "$lib/stores/market-stream.svelte.js";
	import type { LayoutData } from "./$types";

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	// Seed the singleton with server-loaded identity/balance whenever data changes.
	$effect(() => {
		marketStream.setIdentity(data.address, data.balance);
	});

	// Open the SSE stream once for the lifetime of the (app) layout.
	$effect(() => {
		marketStream.connect();
		return () => marketStream.disconnect();
	});
</script>

{@render children()}
