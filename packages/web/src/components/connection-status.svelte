<script lang="ts">
	import { connection } from "$lib/stores/connection.svelte.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
	import CheckIcon from "@lucide/svelte/icons/check";
	import XIcon from "@lucide/svelte/icons/x";

	$effect(() => {
		connection.start();
		return () => connection.stop();
	});

	let connected = $derived(connection.status === "connected");
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#if connected}
			<Badge variant="secondary" class="gap-1 bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20">
				<CheckIcon class="size-3" />
				Connected
			</Badge>
		{:else}
			<Badge variant="destructive">
				<XIcon class="size-3" />
				Not Connected
			</Badge>
		{/if}
	</Tooltip.Trigger>
	<Tooltip.Content>
		{connected ? "API and node are reachable" : "Unable to reach backend services"}
	</Tooltip.Content>
</Tooltip.Root>
