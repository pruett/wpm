<script lang="ts">
	import type { MarketWithOdds, SharePosition } from "@wpm/shared";
	import * as Card from "$lib/components/ui/card/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Separator } from "$lib/components/ui/separator/index.js";
	import { cn } from "$lib/utils.js";
	import BetForm from "./bet-form.svelte";
	import BettorsModal from "./bettors-modal.svelte";

	let {
		market,
		positions = [],
		onBetPlaced,
	}: {
		market: MarketWithOdds;
		positions?: SharePosition[];
		onBetPlaced?: () => void;
	} = $props();

	let selectedOutcome = $state<"A" | "B" | null>(null);
	let bettorsOpen = $state(false);

	const statusConfig = {
		open: { variant: "default" as const, label: "Live" },
		closed: { variant: "secondary" as const, label: "Closed" },
		resolved: { variant: "outline" as const, label: "Resolved" },
		cancelled: { variant: "destructive" as const, label: "Cancelled" },
	};

	let status = $derived(statusConfig[market.status]);
	let isResolved = $derived(market.status === "resolved");
	let isOpen = $derived(market.status === "open");
	let posA = $derived(positions.find((p) => p.outcome === "A"));
	let posB = $derived(positions.find((p) => p.outcome === "B"));

	let outcomeRowClass = $derived(
		cn(
			"flex w-full items-center justify-between py-3 text-left transition-colors",
			isOpen && "cursor-pointer rounded-md px-2 hover:bg-accent/50",
		),
	);

	function selectOutcome(outcome: "A" | "B") {
		if (!isOpen) return;
		selectedOutcome = selectedOutcome === outcome ? null : outcome;
	}

	function handleBetComplete() {
		selectedOutcome = null;
		onBetPlaced?.();
	}
</script>

<Card.Root>
	<Card.Header class="flex flex-row items-start justify-between gap-4">
		<div class="flex flex-col gap-1">
			<Card.Title class="text-base">{market.name}</Card.Title>
			{#if market.bettorCount > 0}
				<button
					type="button"
					class="text-xs text-muted-foreground hover:text-foreground transition-colors text-left"
					onclick={() => (bettorsOpen = true)}
				>
					{market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"}
				</button>
			{/if}
		</div>
		<Card.Action>
			<Badge variant={status.variant}>{status.label}</Badge>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-0">
		<button
			type="button"
			class={cn(outcomeRowClass, {
				"text-foreground": !isResolved || market.result === "A",
				"text-muted-foreground": isResolved && market.result !== "A",
			})}
			disabled={!isOpen}
			onclick={() => selectOutcome("A")}
		>
			<div class="flex flex-col">
				<span class="font-medium">{market.outcomes[0]}</span>
				{#if posA}
					<span class="text-xs text-muted-foreground">
						{posA.shares.toFixed(1)} shares · {posA.costBasis.toLocaleString()} WPM
					</span>
				{/if}
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm tabular-nums">{Math.round(market.priceA * 100)}%</span>
				<span class="text-sm font-semibold tabular-nums">×{market.multiplierA.toFixed(2)}</span>
			</div>
		</button>
		<Separator />
		<button
			type="button"
			class={cn(outcomeRowClass, {
				"text-foreground": !isResolved || market.result === "B",
				"text-muted-foreground": isResolved && market.result !== "B",
			})}
			disabled={!isOpen}
			onclick={() => selectOutcome("B")}
		>
			<div class="flex flex-col">
				<span class="font-medium">{market.outcomes[1]}</span>
				{#if posB}
					<span class="text-xs text-muted-foreground">
						{posB.shares.toFixed(1)} shares · {posB.costBasis.toLocaleString()} WPM
					</span>
				{/if}
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm tabular-nums">{Math.round(market.priceB * 100)}%</span>
				<span class="text-sm font-semibold tabular-nums">×{market.multiplierB.toFixed(2)}</span>
			</div>
		</button>

		{#if selectedOutcome}
			<BetForm
				{market}
				outcome={selectedOutcome}
				onComplete={handleBetComplete}
				onCancel={() => (selectedOutcome = null)}
			/>
		{/if}
	</Card.Content>
</Card.Root>

<BettorsModal {market} bind:open={bettorsOpen} />
