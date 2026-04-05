import { error } from "@sveltejs/kit";
import { MARKET_CATEGORIES } from "@wpm/shared";
import { fetchCategoryMarkets } from "$lib/api.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, fetch }) => {
  const category = MARKET_CATEGORIES.find((c) => c.slug === params.slug);
  if (!category) error(404, "Unknown category");

  const markets = await fetchCategoryMarkets(params.slug, fetch);

  return { category, markets };
};
