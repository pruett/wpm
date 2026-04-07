<script lang="ts">
	import type { DevPersona } from "./index.js";

	let personas = $state<DevPersona[]>([]);
	let active = $state<string | null>(null);
	let open = $state(false);
	let error = $state<string | null>(null);

	let activePersona = $derived(personas.find((p) => p.email === active) ?? null);
	let buttonLabel = $derived(`Persona: ${activePersona?.name ?? "real user"}`);
	let isOverriding = $derived(active !== null);

	async function loadPersonas() {
		try {
			const res = await fetch("/api/dev/personas");
			if (!res.ok) throw new Error(`Failed to load personas (${res.status})`);
			const data = (await res.json()) as { personas: DevPersona[]; active: string | null };
			personas = data.personas;
			active = data.active;
			error = null;
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to load personas";
		}
	}

	$effect(() => {
		void loadPersonas();
	});

	async function switchTo(email: string) {
		try {
			const res = await fetch("/api/dev/personas/switch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email }),
			});
			if (!res.ok) throw new Error(`Failed to switch persona (${res.status})`);
			location.reload();
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to switch persona";
		}
	}

	async function clearPersona() {
		try {
			const res = await fetch("/api/dev/personas/switch", { method: "DELETE" });
			if (!res.ok) throw new Error(`Failed to clear persona (${res.status})`);
			location.reload();
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to clear persona";
		}
	}
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
	{#if open}
		<div
			class="bg-background text-foreground border-border w-72 rounded-md border border-l-2 border-l-amber-500 p-3 shadow-lg"
		>
			<div class="mb-2 flex items-center justify-between">
				<h2 class="text-sm font-semibold text-amber-600">Dev Personas</h2>
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground text-xs"
					onclick={() => (open = false)}
				>
					close
				</button>
			</div>

			{#if error}
				<p class="mb-2 text-xs text-red-500">{error}</p>
			{/if}

			<ul class="flex flex-col gap-1">
				<li>
					<button
						type="button"
						class="w-full rounded px-2 py-1.5 text-left text-xs transition-colors {active ===
						null
							? 'bg-muted text-foreground'
							: 'text-muted-foreground hover:bg-muted/60'}"
						onclick={clearPersona}
					>
						Real user (no override)
					</button>
				</li>
				{#if personas.length === 0}
					<li class="text-muted-foreground px-2 py-1.5 text-xs">
						No personas yet. Run: bun scripts/admin.ts persona add &lt;name&gt; &lt;email&gt;
					</li>
				{:else}
					{#each personas as persona (persona.email)}
						<li>
							<button
								type="button"
								class="w-full rounded px-2 py-1.5 text-left text-xs transition-colors {active ===
								persona.email
									? 'bg-muted text-foreground'
									: 'text-muted-foreground hover:bg-muted/60'}"
								onclick={() => switchTo(persona.email)}
							>
								<div class="font-medium">{persona.name}</div>
								<div class="text-muted-foreground text-[10px]">{persona.email}</div>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		</div>
	{/if}

	<button
		type="button"
		class="bg-background text-foreground inline-flex items-center gap-2 rounded-full border border-amber-500 px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-amber-500/10"
		onclick={() => (open = !open)}
	>
		<span
			class="inline-block h-2 w-2 rounded-full {isOverriding ? 'bg-amber-500' : 'bg-gray-400'}"
			aria-hidden="true"
		></span>
		<span>{buttonLabel}</span>
	</button>
</div>
