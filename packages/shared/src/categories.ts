export type MarketCategory = {
  readonly slug: string;
  readonly name: string;
  readonly sport: string;
  readonly prefix: string;
  readonly logo: string;
};

export const MARKET_CATEGORIES: readonly MarketCategory[] = [
  { slug: "nfl", name: "NFL", sport: "Football", prefix: "nfl-", logo: "/logos/nfl.png" },
  { slug: "mlb", name: "MLB", sport: "Baseball", prefix: "mlb-", logo: "/logos/mlb.png" },
  {
    slug: "golf-pga",
    name: "PGA Golf",
    sport: "Golf",
    prefix: "golf-pga-",
    logo: "/logos/pga.png",
  },
] as const;

export function categoryForMarket(marketId: string): MarketCategory | undefined {
  return MARKET_CATEGORIES.find((c) => marketId.startsWith(c.prefix));
}
