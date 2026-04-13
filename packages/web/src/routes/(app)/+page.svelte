<script lang="ts">
	import MarketList from "../../components/market-list.svelte";
	import Leaderboard from "../../components/leaderboard.svelte";

	let { data } = $props();
</script>

<section class="flex flex-col gap-4">
	<h2 class="text-lg font-semibold">Markets</h2>
	<MarketList markets={data.markets} emptyMessage="No markets available" />
</section>

<section class="mt-8 flex flex-col gap-4">
	<h2 class="text-lg font-semibold">Leaderboard</h2>
	<Leaderboard entries={data.leaderboard} />
</section>
