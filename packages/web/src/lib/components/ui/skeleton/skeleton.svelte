<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$lib/utils.js";

	let {
		class: className,
		...restProps
	}: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class={cn("animate-pulse rounded-md bg-primary/10", className)} {...restProps}></div>
