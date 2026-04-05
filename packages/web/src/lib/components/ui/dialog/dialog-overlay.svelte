<script lang="ts">
	import { Dialog } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		class: className,
		...restProps
	}: Dialog.OverlayProps = $props();
</script>

<Dialog.Overlay
	class={cn("fixed inset-0 z-50 bg-black/80", className)}
	{...restProps}
/>
