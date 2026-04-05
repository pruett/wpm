<script lang="ts">
	import { Dialog } from "bits-ui";
	import { cn } from "$lib/utils.js";
	import DialogOverlay from "./dialog-overlay.svelte";

	let {
		class: className,
		children,
		...restProps
	}: Dialog.ContentProps = $props();
</script>

<Dialog.Portal>
	<DialogOverlay />
	<Dialog.Content
		class={cn(
			"fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg sm:rounded-lg",
			className,
		)}
		{...restProps}
	>
		{@render children?.()}
	</Dialog.Content>
</Dialog.Portal>
