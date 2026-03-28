<script lang="ts">
	import { connection } from "$lib/stores/connection.svelte.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
	import CheckIcon from "@lucide/svelte/icons/check";
	import XIcon from "@lucide/svelte/icons/x";
	import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

	$effect(() => {
		connection.start();
		return () => connection.stop();
	});

	let status = $derived(connection.status);
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#if status === "connected"}
			<Badge variant="secondary" class="gap-1 bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20">
				<CheckIcon class="size-3" />
				Connected
			</Badge>
		{:else if status === "degraded"}
			<Badge variant="secondary" class="gap-1 bg-amber-500/10 text-amber-500 dark:bg-amber-500/20">
				<TriangleAlertIcon class="size-3" />
				Degraded
			</Badge>
		{:else}
			<Badge variant="destructive" class="gap-1">
				<XIcon class="size-3" />
				Disconnected
			</Badge>
		{/if}
	</Tooltip.Trigger>
	<Tooltip.Content>
		{connection.detail}
	</Tooltip.Content>
</Tooltip.Root>
