<script lang="ts">
	import type { MarketWithOdds, SharePosition } from "@wpm/shared";
	import { fetchMarkets, fetchPositions } from "$lib/api.js";
	import { createMarketStream } from "$lib/stores/market-stream.svelte.js";
	import MarketCard from "./market-card.svelte";

	let {
		markets,
		emptyMessage = "No markets available",
	}: {
		markets: MarketWithOdds[];
		emptyMessage?: string;
	} = $props();

	let positions = $state<SharePosition[]>([]);
	const stream = createMarketStream();

	function loadPositions() {
		fetchPositions()
			.then((p) => (positions = p))
			.catch(() => {});
	}

	function refreshAfterBet() {
		loadPositions();
		fetchMarkets()
			.then((res) => stream.setMarkets(res.markets))
			.catch(() => {});
	}

	$effect(() => {
		stream.setMarkets(markets);
		stream.connect();
		loadPositions();

		return () => {
			stream.disconnect();
		};
	});

	function positionsForMarket(marketId: string): SharePosition[] {
		return positions.filter((p) => p.marketId === marketId);
	}
</script>

<div class="flex flex-col gap-4">
	{#each stream.markets as market (market.id)}
		<MarketCard
			{market}
			positions={positionsForMarket(market.id)}
			onBetPlaced={refreshAfterBet}
		/>
	{/each}
	{#if stream.markets.length === 0}
		<p class="text-center text-muted-foreground">{emptyMessage}</p>
	{/if}
</div>
