<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import { cn } from "$lib/utils.js";
	import { type ButtonVariant, type ButtonSize, buttonVariants } from "./index.js";

	let {
		class: className,
		variant = "default",
		size = "default",
		children,
		...restProps
	}: HTMLButtonAttributes & {
		variant?: ButtonVariant;
		size?: ButtonSize;
		children?: import("svelte").Snippet;
	} = $props();
</script>

<button class={cn(buttonVariants({ variant, size }), className)} {...restProps}>
	{@render children?.()}
</button>
