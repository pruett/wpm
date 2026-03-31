<script lang="ts">
	import type { Block, Transaction } from "@wpm/shared";
	import { SvelteSet } from "svelte/reactivity";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import { Separator } from "$lib/components/ui/separator/index.js";
	import { Skeleton } from "$lib/components/ui/skeleton/index.js";

	let blocks = $state<Block[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let expanded = new SvelteSet<number>();

	let sortedBlocks = $derived(
		[...blocks].sort((a, b) => b.index - a.index)
	);

	$effect(() => {
		let cancelled = false;

		fetch("/api/blocks")
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((data: Block[]) => {
				if (cancelled) return;
				blocks = data;
				loading = false;
			})
			.catch((err) => {
				if (cancelled) return;
				error = err.message;
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	function toggleBlock(index: number) {
		if (expanded.has(index)) {
			expanded.delete(index);
		} else {
			expanded.add(index);
		}
	}

	function timeAgo(timestamp: string): string {
		const seconds = Math.floor(
			(Date.now() - new Date(timestamp).getTime()) / 1000
		);
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	function truncate(hash: string, len = 8): string {
		return hash.slice(0, len);
	}

	type TransactionColor = "default" | "secondary" | "destructive" | "outline";

	function txColor(type: Transaction["type"]): TransactionColor {
		const map: Record<Transaction["type"], TransactionColor> = {
			Distribute: "default",
			CreateMarket: "secondary",
			PlaceBet: "outline",
			ResolveMarket: "destructive",
			SettlePayout: "default",
			SellShares: "secondary",
		};
		return map[type];
	}

	function truncateKey(key: string): string {
		const lines = key.split("\n").filter((l) => !l.startsWith("---"));
		const body = lines.join("");
		return "..." + body.slice(-8);
	}

	function txSummary(tx: Transaction): string {
		switch (tx.type) {
			case "Distribute":
				return `${tx.amount.toLocaleString()} WPM to ${truncateKey(tx.to)} \u2014 ${tx.memo}`;
			case "CreateMarket":
				return `${tx.name} (${tx.outcomes[0]} vs ${tx.outcomes[1]}) \u2014 ${tx.seedAmount.toLocaleString()} WPM seed`;
			case "PlaceBet":
				return `${tx.amount.toLocaleString()} WPM on ${tx.outcome} in ${tx.marketId} by ${truncateKey(tx.submitter)}`;
			case "ResolveMarket":
				return `${tx.marketId} \u2192 ${tx.result}`;
			case "SettlePayout":
				return `${tx.amount.toLocaleString()} WPM (${tx.shares} shares) to ${truncateKey(tx.to)} \u2014 ${tx.marketId}`;
			case "SellShares":
				return `${tx.shares} shares of ${tx.outcome} in ${tx.marketId} by ${truncateKey(tx.submitter)}`;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<h1 class="text-lg font-semibold text-foreground">Chain Explorer</h1>

	{#if loading}
		<div class="flex flex-col gap-3">
			{#each { length: 5 } as _, i (i)}
				<Card.Root>
					<Card.Content class="flex items-center gap-4 py-4">
						<Skeleton class="h-5 w-12" />
						<Skeleton class="h-4 w-20" />
						<Skeleton class="h-4 w-24 ml-auto" />
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{:else if error}
		<div class="rounded-lg border border-destructive p-4 text-destructive">
			<p>Failed to load chain: {error}</p>
		</div>
	{:else if sortedBlocks.length === 0}
		<p class="text-center text-muted-foreground">No blocks found</p>
	{:else}
		<div class="flex flex-col gap-2">
			{#each sortedBlocks as block (block.index)}
				{@const isExpanded = expanded.has(block.index)}
				<Card.Root>
					<button
						type="button"
						class="w-full text-left"
						onclick={() => toggleBlock(block.index)}
					>
						<Card.Content class="flex items-center gap-4 py-3 px-4">
							<span class="font-mono text-sm font-semibold tabular-nums text-foreground">
								#{block.index}
							</span>
							<span class="font-mono text-xs text-muted-foreground">
								{truncate(block.hash)}
							</span>
							<span class="text-xs text-muted-foreground">
								{timeAgo(block.timestamp)}
							</span>
							<span class="ml-auto text-xs tabular-nums text-muted-foreground">
								{block.transactions.length} tx{block.transactions.length !== 1 ? "s" : ""}
							</span>
							<span class="text-xs text-muted-foreground transition-transform {isExpanded ? 'rotate-90' : ''}">
								&#9654;
							</span>
						</Card.Content>
					</button>

					{#if isExpanded && block.transactions.length > 0}
						<Separator />
						<Card.Content class="flex flex-col gap-2 py-3 px-4">
							{#each block.transactions as tx, i (i)}
								<div class="flex items-center gap-3 text-sm">
									<Badge variant={txColor(tx.type)} class="shrink-0 text-[10px] w-24 justify-center">
										{tx.type}
									</Badge>
									<span class="text-muted-foreground truncate">
										{txSummary(tx)}
									</span>
								</div>
							{/each}
						</Card.Content>
					{/if}

					{#if isExpanded && block.transactions.length === 0}
						<Separator />
						<Card.Content class="py-3 px-4">
							<span class="text-xs text-muted-foreground">No transactions in this block</span>
						</Card.Content>
					{/if}
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>
