<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$lib/utils.js";

	let {
		class: className,
		children,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & { children?: import("svelte").Snippet } = $props();
</script>

<div
	class={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2", className)}
	{...restProps}
>
	{@render children?.()}
</div>
