<script lang="ts">
	import { auth } from "$lib/stores/auth.svelte.js";
	import RegisterForm from "../components/register-form.svelte";
	import MarketList from "../components/market-list.svelte";
</script>

{#if auth.isLoggedIn}
	<MarketList />
{:else}
	<RegisterForm />
{/if}
