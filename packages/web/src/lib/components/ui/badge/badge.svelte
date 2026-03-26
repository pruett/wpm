<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$lib/utils.js";
	import { type BadgeVariant, badgeVariants } from "./index.js";

	let {
		class: className,
		variant = "default",
		children,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		variant?: BadgeVariant;
		children?: import("svelte").Snippet;
	} = $props();
</script>

<div class={cn(badgeVariants({ variant }), className)} {...restProps}>
	{@render children?.()}
</div>
