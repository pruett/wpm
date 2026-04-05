import { fetchCategories, fetchLeaderboard, fetchMarkets } from "$lib/api.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch }) => {
  const [categories, marketsData, leaderboard] = await Promise.all([
    fetchCategories(fetch),
    fetchMarkets(fetch),
    fetchLeaderboard(fetch),
  ]);

  return { categories, leaderboard, ...marketsData };
};
