export type Transaction =
  | {
      type: "Distribute";
      to: string;
      amount: number;
      memo: string;
      timestamp: string;
    }
  | {
      type: "Transfer";
      from: string;
      to: string;
      amount: number;
      timestamp: string;
    }
  | {
      type: "Referral";
      inviter: string;
      invitee: string;
      amount: number;
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
      logos?: [string, string];
      leagueLogo?: string;
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
  logos?: [string, string];
  leagueLogo?: string;
  closesAt: string;
  status: "open" | "resolved" | "cancelled";
  result?: "A" | "B";
};

export type AMMPool = {
  marketId: string;
  sharesA: number;
  sharesB: number;
  k: number;
  liquidity: number;
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
  pool: AMMPool;
  bettorCount: number;
};

export type MarketBettor = {
  name: string;
  userId: string;
  outcome: "A" | "B";
  shares: number;
  costBasis: number;
};

export type CategoryInfo = {
  slug: string;
  name: string;
  sport: string;
  logo: string;
  marketCount: number;
};

export type MarketsResponse = {
  active: string[];
  markets: MarketWithOdds[];
};

export type LeaderboardEntry = {
  userId: string;
  name: string;
  balance: number;
};
