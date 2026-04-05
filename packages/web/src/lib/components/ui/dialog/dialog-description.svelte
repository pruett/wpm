<script lang="ts">
	import { Dialog } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		class: className,
		...restProps
	}: Dialog.DescriptionProps = $props();
</script>

<Dialog.Description
	class={cn("text-sm text-muted-foreground", className)}
	{...restProps}
/>
