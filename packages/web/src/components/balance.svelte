<script lang="ts">
	import { balance } from "$lib/stores/balance.svelte.js";
	import { Skeleton } from "$lib/components/ui/skeleton/index.js";
</script>

{#if balance.value !== null}
	<span class="text-sm font-medium tabular-nums text-foreground">
		{balance.value.toLocaleString()} WPM
	</span>
{:else}
	<Skeleton class="h-4 w-20" />
{/if}
