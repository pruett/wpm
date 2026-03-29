<script lang="ts">
	import { goto } from "$app/navigation";
	import { authClient } from "$lib/auth-client.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import { onMount } from "svelte";

	let status = $state<"verifying" | "passkey-prompt" | "done" | "error">("verifying");
	let error = $state<string | null>(null);
	let addingPasskey = $state(false);

	onMount(async () => {
		// better-auth handles the magic link verification via the URL token.
		// By the time this page renders, the session cookie should already be set
		// by better-auth's callback handler. Verify we have a session.
		const session = authClient.useSession();

		// Give better-auth a moment to process the callback
		await new Promise((r) => setTimeout(r, 500));

		const current = session.get();
		if (current?.data?.user) {
			status = "passkey-prompt";
		} else {
			status = "error";
			error = "Verification failed. Please try again.";
		}
	});

	async function addPasskey() {
		addingPasskey = true;
		try {
			const { error: passkeyError } = await authClient.passkey.addPasskey({
				name: "WPM Passkey",
			});
			if (passkeyError) throw new Error(passkeyError.message);
		} catch {
			// Passkey is optional — don't block the user
		} finally {
			addingPasskey = false;
			goto("/");
		}
	}

	function skipPasskey() {
		goto("/");
	}
</script>

<div class="flex min-h-[60vh] items-center justify-center">
	<Card.Root class="w-full max-w-sm">
		{#if status === "verifying"}
			<Card.Header>
				<Card.Title>Verifying...</Card.Title>
				<Card.Description>Confirming your login link.</Card.Description>
			</Card.Header>
		{:else if status === "passkey-prompt"}
			<Card.Header>
				<Card.Title>You're in!</Card.Title>
				<Card.Description>
					Want to add a passkey for faster logins? You can use Touch ID, Face ID, or your device's
					biometrics.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<Button onclick={addPasskey} disabled={addingPasskey}>
					{addingPasskey ? "Setting up..." : "Add passkey"}
				</Button>
				<Button variant="ghost" onclick={skipPasskey}>Skip for now</Button>
			</Card.Content>
		{:else if status === "error"}
			<Card.Header>
				<Card.Title>Something went wrong</Card.Title>
				<Card.Description>{error}</Card.Description>
			</Card.Header>
			<Card.Content>
				<a href="/login">
					<Button variant="outline" class="w-full">Back to login</Button>
				</a>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title>Welcome to WPM!</Card.Title>
				<Card.Description>Redirecting...</Card.Description>
			</Card.Header>
		{/if}
	</Card.Root>
</div>
