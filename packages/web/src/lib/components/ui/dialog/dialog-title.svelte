<script lang="ts">
	import { Dialog } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		class: className,
		...restProps
	}: Dialog.TitleProps = $props();
</script>

<Dialog.Title
	class={cn("text-lg font-semibold leading-none tracking-tight", className)}
	{...restProps}
/>
