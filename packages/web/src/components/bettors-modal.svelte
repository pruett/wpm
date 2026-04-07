<script lang="ts">
	import type { MarketWithOdds, MarketBettor } from "@wpm/shared";
	import * as Dialog from "$lib/components/ui/dialog/index.js";
	import { Separator } from "$lib/components/ui/separator/index.js";
	import { Skeleton } from "$lib/components/ui/skeleton/index.js";
	import { fetchMarketBettors } from "$lib/api.js";

	let {
		market,
		open = $bindable(false),
	}: {
		market: MarketWithOdds;
		open: boolean;
	} = $props();

	let bettors = $state<MarketBettor[]>([]);
	let loading = $state(false);

	let bettorsA = $derived(bettors.filter((b) => b.outcome === "A"));
	let bettorsB = $derived(bettors.filter((b) => b.outcome === "B"));

	function truncateAddress(address: string): string {
		if (address.length <= 10) return address;
		return `${address.slice(0, 6)}...${address.slice(-4)}`;
	}

	$effect(() => {
		if (!open) return;
		let stale = false;
		loading = true;
		fetchMarketBettors(market.id)
			.then((result) => {
				if (!stale) bettors = result;
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Positions</Dialog.Title>
			<Dialog.Description>{market.name}</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<Skeleton class="h-4 w-24" />
					<div class="flex items-center justify-between py-1">
						<div class="flex flex-col gap-0.5">
							<Skeleton class="h-4 w-32" />
							<Skeleton class="h-3 w-24" />
						</div>
						<Skeleton class="h-4 w-40" />
					</div>
					<div class="flex items-center justify-between py-1">
						<div class="flex flex-col gap-0.5">
							<Skeleton class="h-4 w-32" />
							<Skeleton class="h-3 w-24" />
						</div>
						<Skeleton class="h-4 w-40" />
					</div>
				</div>

				<Separator />

				<div class="flex flex-col gap-2">
					<Skeleton class="h-4 w-24" />
					<div class="flex items-center justify-between py-1">
						<div class="flex flex-col gap-0.5">
							<Skeleton class="h-4 w-32" />
							<Skeleton class="h-3 w-24" />
						</div>
						<Skeleton class="h-4 w-40" />
					</div>
					<div class="flex items-center justify-between py-1">
						<div class="flex flex-col gap-0.5">
							<Skeleton class="h-4 w-32" />
							<Skeleton class="h-3 w-24" />
						</div>
						<Skeleton class="h-4 w-40" />
					</div>
				</div>
			</div>
		{:else}
			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<span class="text-sm font-medium">{market.outcomes[0]}</span>
					{#if bettorsA.length === 0}
						<span class="text-sm text-muted-foreground">No positions</span>
					{:else}
						{#each bettorsA as bettor (bettor.address)}
							<div class="flex items-center justify-between py-1">
								<div class="flex flex-col gap-0.5">
									<span class="text-sm font-medium">{bettor.name}</span>
									<span class="font-mono text-xs text-muted-foreground">
										{truncateAddress(bettor.address)}
									</span>
								</div>
								<span class="text-sm tabular-nums text-muted-foreground">
									{bettor.shares.toFixed(1)} shares · {bettor.costBasis.toLocaleString()} WPM
								</span>
							</div>
						{/each}
					{/if}
				</div>

				<Separator />

				<div class="flex flex-col gap-2">
					<span class="text-sm font-medium">{market.outcomes[1]}</span>
					{#if bettorsB.length === 0}
						<span class="text-sm text-muted-foreground">No positions</span>
					{:else}
						{#each bettorsB as bettor (bettor.address)}
							<div class="flex items-center justify-between py-1">
								<div class="flex flex-col gap-0.5">
									<span class="text-sm font-medium">{bettor.name}</span>
									<span class="font-mono text-xs text-muted-foreground">
										{truncateAddress(bettor.address)}
									</span>
								</div>
								<span class="text-sm tabular-nums text-muted-foreground">
									{bettor.shares.toFixed(1)} shares · {bettor.costBasis.toLocaleString()} WPM
								</span>
							</div>
						{/each}
					{/if}
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
