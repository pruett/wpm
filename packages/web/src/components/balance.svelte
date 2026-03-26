<script lang="ts">
	import { balance } from "$lib/stores/balance.svelte.js";

	$effect(() => {
		balance.refresh();
	});
</script>

{#if balance.value !== null}
	<span class="text-sm font-medium tabular-nums text-foreground">
		{balance.value.toLocaleString()} WPM
	</span>
{/if}
