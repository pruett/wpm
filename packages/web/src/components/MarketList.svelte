<script lang="ts">
	import { fetchMarkets } from "$lib/api.js";
	import { createMarketStream } from "$lib/stores/market-stream.svelte.js";
	import MarketCard from "./MarketCard.svelte";
	import * as Card from "$lib/components/ui/card/index.js";
	import { Skeleton } from "$lib/components/ui/skeleton/index.js";

	let loading = $state(true);
	let error = $state<string | null>(null);
	const stream = createMarketStream();

	$effect(() => {
		let cancelled = false;

		fetchMarkets()
			.then((markets) => {
				if (cancelled) return;
				stream.setMarkets(markets);
				stream.connect();
				loading = false;
			})
			.catch((err) => {
				if (cancelled) return;
				error = err.message;
				loading = false;
			});

		return () => {
			cancelled = true;
			stream.disconnect();
		};
	});
</script>

{#if loading}
	<div class="flex flex-col gap-4">
		{#each { length: 3 } as _, i (i)}
			<Card.Root>
				<Card.Header>
					<Skeleton class="h-5 w-3/4" />
				</Card.Header>
				<Card.Content class="flex flex-col gap-3">
					<Skeleton class="h-4 w-full" />
					<Skeleton class="h-4 w-full" />
				</Card.Content>
			</Card.Root>
		{/each}
	</div>
{:else if error}
	<div class="rounded-lg border border-destructive p-4 text-destructive">
		<p>Failed to load markets: {error}</p>
	</div>
{:else}
	<div class="flex flex-col gap-4">
		{#each stream.markets as market (market.id)}
			<MarketCard {market} />
		{/each}
		{#if stream.markets.length === 0}
			<p class="text-center text-muted-foreground">No markets available</p>
		{/if}
	</div>
{/if}
