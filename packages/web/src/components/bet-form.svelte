<script lang="ts">
	import type { MarketWithOdds } from "@wpm/shared";
	import { placeBet } from "$lib/api.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Input } from "$lib/components/ui/input/index.js";

	let {
		market,
		outcome,
		onComplete,
		onCancel,
	}: {
		market: MarketWithOdds;
		outcome: "A" | "B";
		onComplete: () => void;
		onCancel: () => void;
	} = $props();

	let amount = $state("");
	let error = $state<string | null>(null);
	let submitting = $state(false);

	let outcomeName = $derived(outcome === "A" ? market.outcomes[0] : market.outcomes[1]);
	let price = $derived(outcome === "A" ? market.priceA : market.priceB);
	let multiplier = $derived(outcome === "A" ? market.multiplierA : market.multiplierB);
	let parsedAmount = $derived(Number(amount));
	let estimatedPayout = $derived(
		!isNaN(parsedAmount) && parsedAmount > 0 ? parsedAmount * multiplier : 0,
	);

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (isNaN(parsedAmount) || parsedAmount <= 0) return;
		error = null;
		submitting = true;
		try {
			await placeBet(market.id, outcome, parsedAmount);
			onComplete();
		} catch (err) {
			error = err instanceof Error ? err.message : "Bet failed";
		} finally {
			submitting = false;
		}
	}
</script>

<form onsubmit={handleSubmit} class="flex flex-col gap-3 border-t border-border pt-3">
	<div class="flex items-center justify-between text-sm">
		<span class="font-medium">{outcomeName}</span>
		<span class="text-muted-foreground">{Math.round(price * 100)}% &middot; &times;{multiplier.toFixed(2)}</span>
	</div>
	<Input
		type="number"
		placeholder="Amount (WPM)"
		bind:value={amount}
		disabled={submitting}
		min="1"
		required
	/>
	{#if estimatedPayout > 0}
		<p class="text-xs text-muted-foreground">
			Est. payout: {estimatedPayout.toLocaleString(undefined, { maximumFractionDigits: 0 })} WPM
		</p>
	{/if}
	{#if error}
		<p class="text-sm text-destructive">{error}</p>
	{/if}
	<div class="flex gap-2">
		<Button type="submit" size="sm" disabled={submitting || isNaN(parsedAmount) || parsedAmount <= 0} class="flex-1">
			{submitting ? "Placing..." : "Place Bet"}
		</Button>
		<Button type="button" variant="ghost" size="sm" onclick={onCancel} disabled={submitting}>
			Cancel
		</Button>
	</div>
</form>
