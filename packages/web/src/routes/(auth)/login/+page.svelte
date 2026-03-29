<script lang="ts">
	import { goto } from "$app/navigation";
	import { authClient } from "$lib/auth-client.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import { Separator } from "$lib/components/ui/separator/index.js";

	let email = $state("");
	let error = $state<string | null>(null);
	let submitting = $state(false);
	let magicLinkSent = $state(false);

	async function handlePasskey() {
		error = null;
		submitting = true;
		try {
			const { error: authError } = await authClient.signIn.passkey();
			if (authError) throw new Error(authError.message);
			goto("/");
		} catch (err) {
			error = err instanceof Error ? err.message : "Passkey sign in failed";
		} finally {
			submitting = false;
		}
	}

	async function handleMagicLink(e: SubmitEvent) {
		e.preventDefault();
		if (!email.trim()) return;
		error = null;
		submitting = true;
		try {
			const { error: authError } = await authClient.signIn.magicLink({
				email: email.trim(),
				callbackURL: "/auth/verify",
			});
			if (authError) throw new Error(authError.message);
			magicLinkSent = true;
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to send magic link";
		} finally {
			submitting = false;
		}
	}
</script>

<div class="flex min-h-[60vh] items-center justify-center">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title>Welcome back</Card.Title>
			<Card.Description>Sign in to your WPM account</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if magicLinkSent}
				<p class="text-sm text-muted-foreground">
					Check your email — we sent a login link to
					<span class="font-medium text-foreground">{email}</span>.
				</p>
			{:else}
				<Button onclick={handlePasskey} disabled={submitting} class="w-full">
					Sign in with passkey
				</Button>

				<div class="flex items-center gap-3">
					<Separator class="flex-1" />
					<span class="text-xs text-muted-foreground">or</span>
					<Separator class="flex-1" />
				</div>

				<form onsubmit={handleMagicLink} class="flex flex-col gap-3">
					<Input
						type="email"
						placeholder="Email address"
						bind:value={email}
						disabled={submitting}
						required
					/>
					<Button type="submit" variant="outline" disabled={submitting || !email.trim()}>
						{submitting ? "Sending..." : "Send magic link"}
					</Button>
				</form>

				{#if error}
					<p class="text-sm text-destructive">{error}</p>
				{/if}
			{/if}
		</Card.Content>
		<Card.Footer class="justify-center">
			<p class="text-sm text-muted-foreground">
				Don't have an account? <a href="/signup" class="text-foreground underline">Sign up</a>
			</p>
		</Card.Footer>
	</Card.Root>
</div>
