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
      outcome: "A" | "B";
      amount: number;
      userId: string;
      timestamp: string;
    }
  | {
      type: "SellShares";
      marketId: string;
      outcome: "A" | "B";
      shares: number;
      userId: string;
      timestamp: string;
    }
  | {
      type: "ResolveMarket";
      marketId: string;
      result: "A" | "B";
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

export type Market = {
  id: string;
  name: string;
  outcomes: [string, string];
  closesAt: string;
  status: "open" | "resolved" | "cancelled";
  result?: "A" | "B";
};

export type AMMPool = {
  marketId: string;
  sharesA: bigint;
  sharesB: bigint;
  k: bigint;
  liquidity: bigint;
};

export type SharePosition = {
  userId: string;
  marketId: string;
  outcome: "A" | "B";
  shares: number;
  costBasis: number;
};

export type MarketWithOdds = Market & {
  priceA: number;
  priceB: number;
  multiplierA: number;
  multiplierB: number;
  bettorCount: number;
};

export type MarketsResponse = {
  markets: MarketWithOdds[];
};

export type LeaderboardEntry = {
  userId: string;
  name: string;
  balance: number;
};
