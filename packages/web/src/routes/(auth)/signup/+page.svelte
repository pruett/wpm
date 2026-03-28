<script lang="ts">
	import { goto } from "$app/navigation";
	import { register } from "$lib/api.js";
	import { auth } from "$lib/stores/auth.svelte.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import * as Card from "$lib/components/ui/card/index.js";

	let name = $state("");
	let error = $state<string | null>(null);
	let submitting = $state(false);

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!name.trim()) return;
		error = null;
		submitting = true;
		try {
			const result = await register(name.trim());
			auth.login(result.token, result.address);
			goto("/");
		} catch (err) {
			error = err instanceof Error ? err.message : "Registration failed";
		} finally {
			submitting = false;
		}
	}
</script>

<div class="flex min-h-[60vh] items-center justify-center">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title>Join WPM</Card.Title>
			<Card.Description>Enter your name to start trading</Card.Description>
		</Card.Header>
		<Card.Content>
			<form onsubmit={handleSubmit} class="flex flex-col gap-4">
				<Input placeholder="Your name" bind:value={name} disabled={submitting} required />
				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}
				<Button type="submit" disabled={submitting || !name.trim()}>
					{submitting ? "Joining..." : "Join"}
				</Button>
			</form>
		</Card.Content>
		<Card.Footer class="justify-center">
			<p class="text-sm text-muted-foreground">
				Already have an account? <a href="/login" class="text-foreground underline">Log in</a>
			</p>
		</Card.Footer>
	</Card.Root>
</div>
