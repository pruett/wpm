import type {
  Block,
  Market,
  AMMPool,
  SharePosition,
  Transaction,
  TransferTx,
  DistributeTx,
  CreateMarketTx,
  PlaceBetTx,
  SellSharesTx,
  ResolveMarketTx,
  CancelMarketTx,
  SettlePayoutTx,
  ReferralTx,
} from "@wpm/shared";

export class ChainState {
  chain: Block[] = [];
  balances: Map<string, number> = new Map();
  committedTxIds: Set<string> = new Set();
  referredUsers: Set<string> = new Set();
  markets: Map<string, Market> = new Map();
  pools: Map<string, AMMPool> = new Map();
  sharePositions: Map<string, Map<string, Map<string, SharePosition>>> =
    new Map();
  externalEventIds: Map<string, string> = new Map();

  private readonly poaPublicKey: string;

  constructor(poaPublicKey: string) {
    this.poaPublicKey = poaPublicKey;
  }

  get treasuryAddress(): string {
    return this.poaPublicKey;
  }

  getBalance(address: string): number {
    return this.balances.get(address) ?? 0;
  }

  setBalance(address: string, amount: number): void {
    this.balances.set(address, amount);
  }

  credit(address: string, amount: number): void {
    this.setBalance(address, this.getBalance(address) + amount);
  }

  debit(address: string, amount: number): void {
    this.setBalance(address, this.getBalance(address) - amount);
  }

  getSharePosition(
    address: string,
    marketId: string,
    outcome: string,
  ): SharePosition {
    return (
      this.sharePositions.get(address)?.get(marketId)?.get(outcome) ?? {
        shares: 0,
        costBasis: 0,
      }
    );
  }

  setSharePosition(
    address: string,
    marketId: string,
    outcome: string,
    position: SharePosition,
  ): void {
    if (!this.sharePositions.has(address)) {
      this.sharePositions.set(address, new Map());
    }
    const byAddress = this.sharePositions.get(address)!;
    if (!byAddress.has(marketId)) {
      byAddress.set(marketId, new Map());
    }
    byAddress.get(marketId)!.set(outcome, position);
  }

  applyBlock(block: Block): void {
    for (const tx of block.transactions) {
      this.applyTransaction(tx);
    }
    this.chain.push(block);
  }

  private applyTransaction(tx: Transaction): void {
    this.committedTxIds.add(tx.id);

    switch (tx.type) {
      case "Transfer":
        this.applyTransfer(tx);
        break;
      case "Distribute":
        this.applyDistribute(tx);
        break;
      case "CreateMarket":
        this.applyCreateMarket(tx);
        break;
      case "PlaceBet":
        this.applyPlaceBet(tx);
        break;
      case "SellShares":
        this.applySellShares(tx);
        break;
      case "ResolveMarket":
        this.applyResolveMarket(tx);
        break;
      case "CancelMarket":
        this.applyCancelMarket(tx);
        break;
      case "SettlePayout":
        this.applySettlePayout(tx);
        break;
      case "Referral":
        this.applyReferral(tx);
        break;
    }
  }

  private applyTransfer(tx: TransferTx): void {
    this.debit(tx.sender, tx.amount);
    this.credit(tx.recipient, tx.amount);
  }

  private applyDistribute(tx: DistributeTx): void {
    if (tx.sender !== tx.recipient) {
      this.debit(tx.sender, tx.amount);
    }
    this.credit(tx.recipient, tx.amount);
  }

  private applyCreateMarket(tx: CreateMarketTx): void {
    this.debit(this.treasuryAddress, tx.seedAmount);

    const market: Market = {
      marketId: tx.marketId,
      sport: tx.sport,
      homeTeam: tx.homeTeam,
      awayTeam: tx.awayTeam,
      outcomeA: tx.outcomeA,
      outcomeB: tx.outcomeB,
      eventStartTime: tx.eventStartTime,
      seedAmount: tx.seedAmount,
      externalEventId: tx.externalEventId,
      status: "open",
      createdAt: tx.timestamp,
    };
    this.markets.set(tx.marketId, market);

    const halfSeed = tx.seedAmount / 2;
    const pool: AMMPool = {
      marketId: tx.marketId,
      sharesA: halfSeed,
      sharesB: halfSeed,
      k: halfSeed * halfSeed,
      wpmLocked: tx.seedAmount,
    };
    this.pools.set(tx.marketId, pool);

    this.externalEventIds.set(tx.externalEventId, tx.marketId);
  }

  private applyPlaceBet(_tx: PlaceBetTx): void {
    // AMM math (mint-then-swap) will be implemented in Phase 1
    // when @wpm/shared/amm is created
    throw new Error("PlaceBet state application not yet implemented");
  }

  private applySellShares(_tx: SellSharesTx): void {
    // AMM sell math will be implemented in Phase 1
    // when @wpm/shared/amm is created
    throw new Error("SellShares state application not yet implemented");
  }

  private applyResolveMarket(tx: ResolveMarketTx): void {
    const market = this.markets.get(tx.marketId)!;
    market.status = "resolved";
    market.winningOutcome = tx.winningOutcome;
    market.finalScore = tx.finalScore;
    market.resolvedAt = tx.timestamp;
  }

  private applyCancelMarket(tx: CancelMarketTx): void {
    const market = this.markets.get(tx.marketId)!;
    market.status = "cancelled";
    market.resolvedAt = tx.timestamp;
  }

  private applySettlePayout(tx: SettlePayoutTx): void {
    const pool = this.pools.get(tx.marketId)!;
    pool.wpmLocked -= tx.amount;
    this.credit(tx.recipient, tx.amount);
  }

  private applyReferral(tx: ReferralTx): void {
    this.debit(tx.sender, tx.amount);
    this.credit(tx.recipient, tx.amount);
    this.referredUsers.add(tx.referredUser);
  }
}
