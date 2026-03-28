<script lang="ts">
	import * as Card from "$lib/components/ui/card/index.js";
	import { buttonVariants } from "$lib/components/ui/button/index.js";
</script>

<div class="flex min-h-[60vh] items-center justify-center">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title>Welcome back</Card.Title>
			<Card.Description>
				No active session found. WPM accounts are tied to this browser's storage.
			</Card.Description>
		</Card.Header>
		<Card.Footer class="justify-center">
			<a href="/signup" class={buttonVariants({ variant: "default" })}>Create an account</a>
		</Card.Footer>
	</Card.Root>
</div>
