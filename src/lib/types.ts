export type Transaction =
  | {
      type: "Distribute";
      to: string;
      amount: number;
      memo: string;
      timestamp: string;
    }
  | {
      type: "CreateMarket";
      id: string;
      name: string;
      outcomes: [string, string];
      closesAt: string;
      seedAmount: number;
      initialProbabilityA?: number;
      timestamp: string;
    }
  | {
      type: "PlaceBet";
      marketId: string;
      amount: number;
      userId: string;
      timestamp: string;
    }
  | {
      type: "ResolveMarket";
      marketId: string;
      outcome:
        | "resolved_yes"
        | "resolved_no"
        | "cancelled_voided"
        | "cancelled_scalar"
        | "cancelled_no_settlement";
      finalStatus: "resolved" | "cancelled";
      resolvedAs: "yes" | "no" | null;
      reason?: string;
      timestamp: string;
    }
  | {
      type: "SettlePayout";
      marketId: string;
      to: string;
      shares: number;
      amount: number;
      kind: "win" | "loss" | "refund";
      timestamp: string;
    }
  | {
      type: "TreasuryBackstop";
      marketId: string;
      amount: number;
      timestamp: string;
    }
  | {
      type: "CancelMarket";
      marketId: string;
      reason: string;
      timestamp: string;
    };

export const SPORTS = ["mlb", "nfl", "nba", "nhl"] as const;
export type Sport = (typeof SPORTS)[number];

export type Market = {
  id: string;
  eventId: string;
  name: string;
  status: "open" | "resolved" | "cancelled";
  resolvedAs: "yes" | "no" | null;
};

export type Event = {
  id: string;
  sport: Sport;
  name: string;
  closesAt: string;
  status: "open" | "terminal";
  markets: Market[];
};

export type AMMPool = {
  marketId: string;
  reserveYes: bigint;
  reserveNo: bigint;
  k: bigint;
  liquidity: bigint;
};

export type SharePosition = {
  userId: string;
  marketId: string;
  shares: number;
  costBasis: number;
};

export type MarketWithOdds = Market & {
  sport: Sport;
  closesAt: string;
  priceYes: number;
  multiplierYes: number;
  bettorCount: number;
  bettors: {
    id: string;
    name: string;
    color: string | null;
  }[];
};

export type MarketsResponse = {
  markets: MarketWithOdds[];
};

export type LeaderboardEntry = {
  userId: string;
  name: string;
  balance: number;
};
