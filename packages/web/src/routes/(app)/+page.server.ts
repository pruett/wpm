import { fetchLeaderboard, fetchMarkets } from "$lib/api.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch }) => {
  const [marketsData, leaderboard] = await Promise.all([
    fetchMarkets(fetch),
    fetchLeaderboard(fetch),
  ]);

  return { leaderboard, ...marketsData };
};
