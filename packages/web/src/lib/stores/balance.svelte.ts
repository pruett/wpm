import { fetchBalance } from "$lib/api.js";
import { auth } from "./auth.svelte.js";

let _balance = $state<number | null>(null);

export const balance = {
  get value() {
    return _balance;
  },

  set(val: number) {
    _balance = val;
  },

  async refresh() {
    if (!auth.isLoggedIn) return;
    try {
      _balance = await fetchBalance();
    } catch {
      // ignore
    }
  },
};
