<script lang="ts">
	import { balance } from "$lib/stores/balance.svelte.js";
</script>

{#if balance.value !== null}
	<span class="text-sm font-medium tabular-nums text-foreground">
		{balance.value.toLocaleString()} WPM
	</span>
{:else}
	<span class="text-sm text-muted-foreground">Loading...</span>
{/if}
