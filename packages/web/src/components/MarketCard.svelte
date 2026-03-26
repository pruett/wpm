<script lang="ts">
	import type { MarketWithOdds } from "@wpm/shared";
	import * as Card from "$lib/components/ui/card/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Separator } from "$lib/components/ui/separator/index.js";

	let { market }: { market: MarketWithOdds } = $props();

	const statusConfig = {
		open: { variant: "default" as const, label: "Live" },
		closed: { variant: "secondary" as const, label: "Closed" },
		resolved: { variant: "outline" as const, label: "Resolved" },
		cancelled: { variant: "destructive" as const, label: "Cancelled" },
	};

	let status = $derived(statusConfig[market.status]);
	let isResolved = $derived(market.status === "resolved");
</script>

<Card.Root>
	<Card.Header class="flex flex-row items-start justify-between gap-4">
		<Card.Title class="text-base">{market.name}</Card.Title>
		<Card.Action>
			<Badge variant={status.variant}>{status.label}</Badge>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-0">
		<div
			class="flex items-center justify-between py-3"
			class:text-foreground={!isResolved || market.result === "A"}
			class:text-muted-foreground={isResolved && market.result !== "A"}
		>
			<span class="font-medium">{market.outcomes[0]}</span>
			<div class="flex items-center gap-4">
				<span class="text-sm tabular-nums">{Math.round(market.priceA * 100)}%</span>
				<span class="text-sm font-semibold tabular-nums">&times;{market.multiplierA.toFixed(2)}</span>
			</div>
		</div>
		<Separator />
		<div
			class="flex items-center justify-between py-3"
			class:text-foreground={!isResolved || market.result === "B"}
			class:text-muted-foreground={isResolved && market.result !== "B"}
		>
			<span class="font-medium">{market.outcomes[1]}</span>
			<div class="flex items-center gap-4">
				<span class="text-sm tabular-nums">{Math.round(market.priceB * 100)}%</span>
				<span class="text-sm font-semibold tabular-nums">&times;{market.multiplierB.toFixed(2)}</span>
			</div>
		</div>
	</Card.Content>
</Card.Root>
