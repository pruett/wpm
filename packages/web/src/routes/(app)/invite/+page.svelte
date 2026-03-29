<script lang="ts">
	import { enhance } from "$app/forms";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";

	let { data, form } = $props();
	let submitting = $state(false);
</script>

<div class="flex flex-col gap-6">
	<Card.Root>
		<Card.Header>
			<Card.Title>Invite a friend</Card.Title>
			<Card.Description>They'll receive an email with a link to join WPM</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if form?.success}
				<p class="text-sm text-muted-foreground">
					Invite sent to <span class="font-medium text-foreground">{form.email}</span>
				</p>
			{:else}
				<form
					method="POST"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							submitting = false;
							await update();
						};
					}}
					class="flex gap-2"
				>
					<Input
						type="email"
						name="email"
						placeholder="friend@example.com"
						disabled={submitting}
						required
						class="flex-1"
					/>
					<Button type="submit" disabled={submitting}>
						{submitting ? "Sending..." : "Invite"}
					</Button>
				</form>
				{#if form?.error}
					<p class="mt-2 text-sm text-destructive">{form.error}</p>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>

	{#if data.invites.length > 0}
		<Card.Root>
			<Card.Header>
				<Card.Title>Your invites</Card.Title>
			</Card.Header>
			<Card.Content>
				<ul class="flex flex-col gap-2">
					{#each data.invites as invite (invite.code)}
						<li class="flex items-center justify-between text-sm">
							<span>{invite.invitedEmail}</span>
							{#if invite.usedBy}
								<Badge variant="secondary">Joined</Badge>
							{:else}
								<Badge variant="outline">Pending</Badge>
							{/if}
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
