<script lang="ts">
	import type { CategoryInfo, MarketWithOdds } from "@wpm/shared";
	import MarketList from "../../components/market-list.svelte";
	import Leaderboard from "../../components/leaderboard.svelte";
	import * as Card from "$lib/components/ui/card/index.js";

	let { data } = $props();

	let activeMarkets = $derived(
		data.markets.filter((m: MarketWithOdds) => data.active.includes(m.id)),
	);
</script>

{#if activeMarkets.length > 0}
	<section class="flex flex-col gap-4">
		<h2 class="text-lg font-semibold">Active Markets</h2>
		<MarketList markets={activeMarkets} emptyMessage="No active markets" />
	</section>
{/if}

<section class="flex flex-col gap-4" class:mt-8={activeMarkets.length > 0}>
	<h2 class="text-lg font-semibold">Browse Markets</h2>
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
		{#each data.categories as cat (cat.slug)}
			<a href="/categories/{cat.slug}" class="no-underline">
				<Card.Root class="transition-colors hover:bg-accent/50">
					<Card.Header class="items-center text-center">
						<img
							src={cat.logo}
							alt={cat.name}
							class="h-12 w-12 object-contain"
							onerror={(e: Event) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
						/>
						<Card.Title class="text-base">{cat.name}</Card.Title>
					</Card.Header>
					<Card.Content class="text-center">
						<p class="text-sm text-muted-foreground">
							{cat.sport} &middot; {cat.marketCount} {cat.marketCount === 1 ? "market" : "markets"}
						</p>
					</Card.Content>
				</Card.Root>
			</a>
		{/each}
	</div>
</section>

<section class="mt-8 flex flex-col gap-4">
	<h2 class="text-lg font-semibold">Leaderboard</h2>
	<Leaderboard entries={data.leaderboard} />
</section>
