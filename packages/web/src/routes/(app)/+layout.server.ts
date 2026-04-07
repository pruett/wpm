import { redirect } from "@sveltejs/kit";
import { fetchUserBalance } from "$lib/server/balance.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.session) {
    redirect(302, "/login");
  }
  const { balance, address } = await fetchUserBalance(locals.user!);
  return {
    user: locals.user,
    balance,
    address,
  };
};
