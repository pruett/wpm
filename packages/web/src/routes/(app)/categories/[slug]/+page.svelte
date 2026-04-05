<script lang="ts">
	import MarketList from "../../../../components/market-list.svelte";

	let { data } = $props();
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center gap-3">
		<a href="/" class="text-sm text-muted-foreground hover:text-foreground">&larr; Back</a>
		<div class="flex items-center gap-2">
			<img
				src={data.category.logo}
				alt={data.category.name}
				class="h-8 w-8 object-contain"
				onerror={(e: Event) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
			/>
			<h1 class="text-xl font-semibold">{data.category.name}</h1>
		</div>
	</div>

	<MarketList
		markets={data.markets}
		emptyMessage="No {data.category.name} markets available"
	/>
</div>
