<script lang="ts">
	import { page } from "$app/state";
	import { authClient } from "$lib/auth-client.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import * as Card from "$lib/components/ui/card/index.js";

	const inviteCode = page.url.searchParams.get("code") || page.url.searchParams.get("bypass");

	let name = $state("");
	let email = $state("");
	let error = $state<string | null>(null);
	let submitting = $state(false);
	let sent = $state(false);

	async function handleSignup(e: SubmitEvent) {
		e.preventDefault();
		if (!name.trim() || !email.trim()) return;
		error = null;
		submitting = true;
		try {
			const { error: authError } = await authClient.signIn.magicLink({
				email: email.trim(),
				name: name.trim(),
				callbackURL: "/auth/verify",
				metadata: { inviteCode },
			});
			if (authError) throw new Error(authError.message);
			sent = true;
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to send magic link";
		} finally {
			submitting = false;
		}
	}
</script>

<div class="flex min-h-[60vh] items-center justify-center">
	<Card.Root class="w-full max-w-sm">
		{#if !inviteCode}
			<Card.Header>
				<Card.Title>Invite required</Card.Title>
				<Card.Description>
					You need an invite link to join WPM. Ask a friend who's already on the platform.
				</Card.Description>
			</Card.Header>
		{:else if sent}
			<Card.Header>
				<Card.Title>Check your email</Card.Title>
				<Card.Description>
					We sent a login link to <span class="font-medium text-foreground">{email}</span>. Click
					the link to finish signing up.
				</Card.Description>
			</Card.Header>
		{:else}
			<Card.Header>
				<Card.Title>Join WPM</Card.Title>
				<Card.Description>You've been invited! Create your account below.</Card.Description>
			</Card.Header>
			<Card.Content>
				<form onsubmit={handleSignup} class="flex flex-col gap-4">
					<Input placeholder="Your name" bind:value={name} disabled={submitting} required />
					<Input
						type="email"
						placeholder="Email address"
						bind:value={email}
						disabled={submitting}
						required
					/>
					{#if error}
						<p class="text-sm text-destructive">{error}</p>
					{/if}
					<Button type="submit" disabled={submitting || !name.trim() || !email.trim()}>
						{submitting ? "Sending..." : "Send magic link"}
					</Button>
				</form>
			</Card.Content>
		{/if}
		<Card.Footer class="justify-center">
			<p class="text-sm text-muted-foreground">
				Already have an account? <a href="/login" class="text-foreground underline">Log in</a>
			</p>
		</Card.Footer>
	</Card.Root>
</div>
