<script lang="ts">
	import type { LeaderboardEntry } from "@wpm/shared";
	import * as Card from "$lib/components/ui/card/index.js";

	let { entries }: { entries: LeaderboardEntry[] } = $props();

	function truncateAddress(address: string): string {
		if (address.length <= 10) return address;
		return `${address.slice(0, 6)}...${address.slice(-4)}`;
	}

	function rankColor(rank: number): string {
		if (rank === 1) return "text-yellow-500";
		if (rank === 2) return "text-zinc-400";
		if (rank === 3) return "text-amber-700";
		return "text-muted-foreground";
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Leaderboard</Card.Title>
	</Card.Header>
	<Card.Content>
		{#if entries.length === 0}
			<p class="text-center text-muted-foreground">No entries yet</p>
		{:else}
			<div class="flex flex-col">
				{#each entries as entry, i (entry.address)}
					{@const rank = i + 1}
					<div class="flex items-center gap-4 border-b border-border py-3 last:border-b-0">
						<span class="w-8 text-center text-sm font-semibold tabular-nums {rankColor(rank)}">
							{rank}
						</span>
						<div class="flex flex-1 flex-col gap-0.5">
							<span class="text-sm font-medium text-foreground">{entry.name}</span>
							<span class="font-mono text-xs text-muted-foreground">
								{truncateAddress(entry.address)}
							</span>
						</div>
						<span class="text-sm font-semibold tabular-nums text-foreground">
							{entry.balance.toLocaleString()} WPM
						</span>
					</div>
				{/each}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
