export type Transaction =
  | {
      type: "Distribute";
      to: string;
      amount: number;
      memo: string;
      signature: string;
      timestamp: string;
    }
  | {
      type: "CreateMarket";
      id: string;
      name: string;
      outcomes: [string, string];
      closesAt: string;
      seedAmount: number;
      signature: string;
      timestamp: string;
    }
  | {
      type: "PlaceBet";
      marketId: string;
      outcome: "A" | "B";
      amount: number;
      submitter: string;
      signature: string;
      timestamp: string;
    }
  | {
      type: "ResolveMarket";
      marketId: string;
      result: "A" | "B";
      signature: string;
      timestamp: string;
    }
  | {
      type: "SettlePayout";
      marketId: string;
      to: string;
      shares: number;
      amount: number;
      signature: string;
      timestamp: string;
    }
  | {
      type: "CancelMarket";
      marketId: string;
      reason: string;
      signature: string;
      timestamp: string;
    };

export type Block = {
  index: number;
  timestamp: string;
  transactions: Transaction[];
  previousHash: string;
  hash: string;
  signature: string;
  signer: string;
};

export type Market = {
  id: string;
  name: string;
  outcomes: [string, string];
  closesAt: string;
  status: "open" | "closed" | "resolved" | "cancelled";
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
  owner: string;
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
};

export type TradeExecutedEvent = {
  type: "trade:executed";
  marketId: string;
  pool: AMMPool;
};

export type MarketResolvedEvent = {
  type: "market:resolved";
  marketId: string;
  result: "A" | "B";
};

export type MarketCancelledEvent = {
  type: "market:cancelled";
  marketId: string;
  reason: string;
};

export type NodeEvent = TradeExecutedEvent | MarketResolvedEvent | MarketCancelledEvent;

export type PriceUpdateEvent = {
  type: "price:update";
  marketId: string;
  priceA: number;
  priceB: number;
  multiplierA: number;
  multiplierB: number;
};
