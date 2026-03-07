// --- Transaction Types ---

type TransferTx = {
  id: string;
  type: "Transfer";
  timestamp: number;
  sender: string;
  signature: string;
  recipient: string;
  amount: number;
};

type DistributeTx = {
  id: string;
  type: "Distribute";
  timestamp: number;
  sender: string;
  signature: string;
  recipient: string;
  amount: number;
  reason: "signup_airdrop" | "referral_reward" | "manual" | "genesis";
};

type CreateMarketTx = {
  id: string;
  type: "CreateMarket";
  timestamp: number;
  sender: string;
  signature: string;
  marketId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  outcomeA: string;
  outcomeB: string;
  eventStartTime: number;
  seedAmount: number;
  externalEventId: string;
};

type PlaceBetTx = {
  id: string;
  type: "PlaceBet";
  timestamp: number;
  sender: string;
  signature: string;
  marketId: string;
  outcome: "A" | "B";
  amount: number;
};

type SellSharesTx = {
  id: string;
  type: "SellShares";
  timestamp: number;
  sender: string;
  signature: string;
  marketId: string;
  outcome: "A" | "B";
  shareAmount: number;
};

type ResolveMarketTx = {
  id: string;
  type: "ResolveMarket";
  timestamp: number;
  sender: string;
  signature: string;
  marketId: string;
  winningOutcome: "A" | "B";
  finalScore: string;
};

type CancelMarketTx = {
  id: string;
  type: "CancelMarket";
  timestamp: number;
  sender: string;
  signature: string;
  marketId: string;
  reason: string;
};

type SettlePayoutTx = {
  id: string;
  type: "SettlePayout";
  timestamp: number;
  sender: string;
  signature: string;
  marketId: string;
  recipient: string;
  amount: number;
  payoutType: "winnings" | "liquidity_return";
};

type ReferralTx = {
  id: string;
  type: "Referral";
  timestamp: number;
  sender: string;
  signature: string;
  recipient: string;
  amount: number;
  referredUser: string;
};

type TransactionType =
  | "Transfer"
  | "Distribute"
  | "CreateMarket"
  | "PlaceBet"
  | "SellShares"
  | "ResolveMarket"
  | "CancelMarket"
  | "SettlePayout"
  | "Referral";

type Transaction =
  | TransferTx
  | DistributeTx
  | CreateMarketTx
  | PlaceBetTx
  | SellSharesTx
  | ResolveMarketTx
  | CancelMarketTx
  | SettlePayoutTx
  | ReferralTx;

// --- Block ---

type Block = {
  index: number;
  timestamp: number;
  transactions: Transaction[];
  previousHash: string;
  hash: string;
  signature: string;
};

// --- Market & AMM ---

type MarketStatus = "open" | "resolved" | "cancelled";

type Market = {
  marketId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  outcomeA: string;
  outcomeB: string;
  eventStartTime: number;
  seedAmount: number;
  externalEventId: string;
  status: MarketStatus;
  winningOutcome?: "A" | "B";
  finalScore?: string;
  createdAt: number;
  resolvedAt?: number;
};

type AMMPool = {
  marketId: string;
  sharesA: number;
  sharesB: number;
  k: number;
  wpmLocked: number;
};

// --- Share Position ---

type SharePosition = {
  shares: number;
  costBasis: number;
};

// --- Chain State ---

type ChainState = {
  chain: Block[];
  balances: Map<string, number>;
  committedTxIds: Set<string>;
  referredUsers: Set<string>;
  markets: Map<string, Market>;
  pools: Map<string, AMMPool>;
  sharePositions: Map<string, Map<string, Map<string, SharePosition>>>;
  externalEventIds: Map<string, string>;
};

export type {
  TransferTx,
  DistributeTx,
  CreateMarketTx,
  PlaceBetTx,
  SellSharesTx,
  ResolveMarketTx,
  CancelMarketTx,
  SettlePayoutTx,
  ReferralTx,
  TransactionType,
  Transaction,
  Block,
  MarketStatus,
  Market,
  AMMPool,
  SharePosition,
  ChainState,
};
