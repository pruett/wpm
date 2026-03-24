import { Context, Effect, Layer, Ref } from "effect";
import type { Block, Market, AMMPool, SharePosition } from "@wpm/shared";
import { initializePool, calculateBuy, addressOf } from "@wpm/shared";

export interface ChainStateData {
  readonly chain: Block[];
  readonly balances: Map<string, number>;
  readonly markets: Map<string, Market>;
  readonly pools: Map<string, AMMPool>;
  readonly positions: Map<string, SharePosition>;
}

function emptyState(): ChainStateData {
  return {
    chain: [],
    balances: new Map(),
    markets: new Map(),
    pools: new Map(),
    positions: new Map(),
  };
}

function applyBlockPure(state: ChainStateData, block: Block): ChainStateData {
  const balances = new Map(state.balances);
  const markets = new Map(state.markets);
  const pools = new Map(state.pools);
  const positions = new Map(state.positions);
  const chain = [...state.chain, block];

  for (const tx of block.transactions) {
    switch (tx.type) {
      case "Distribute": {
        const addr = addressOf(tx.to);
        balances.set(addr, (balances.get(addr) ?? 0) + tx.amount);
        break;
      }

      case "CreateMarket": {
        markets.set(tx.id, {
          id: tx.id,
          name: tx.name,
          outcomes: tx.outcomes,
          closesAt: tx.closesAt,
          status: "open",
        });
        pools.set(tx.id, initializePool(tx.id, tx.seedAmount));
        const signerAddr = addressOf(block.signer);
        balances.set(signerAddr, (balances.get(signerAddr) ?? 0) - tx.seedAmount);
        break;
      }

      case "PlaceBet": {
        const pool = pools.get(tx.marketId)!;
        const { shares, newPool } = calculateBuy(pool, tx.outcome, tx.amount);
        pools.set(tx.marketId, newPool);
        const submitterAddr = addressOf(tx.submitter);
        balances.set(submitterAddr, (balances.get(submitterAddr) ?? 0) - tx.amount);
        const posKey = `${submitterAddr}:${tx.marketId}:${tx.outcome}`;
        const existing = positions.get(posKey);
        positions.set(posKey, {
          owner: submitterAddr,
          marketId: tx.marketId,
          outcome: tx.outcome,
          shares: (existing?.shares ?? 0) + shares,
          costBasis: (existing?.costBasis ?? 0) + tx.amount,
        });
        break;
      }
    }
  }

  return { chain, balances, markets, pools, positions };
}

export class ChainState extends Context.Tag("ChainState")<
  ChainState,
  {
    readonly get: Effect.Effect<ChainStateData>;
    readonly getBalance: (address: string) => Effect.Effect<number>;
    readonly getMarket: (id: string) => Effect.Effect<Market | undefined>;
    readonly getMarkets: Effect.Effect<Array<{ market: Market; pool: AMMPool }>>;
    readonly getPool: (marketId: string) => Effect.Effect<AMMPool | undefined>;
    readonly getPositions: (owner: string) => Effect.Effect<SharePosition[]>;
    readonly applyBlock: (block: Block) => Effect.Effect<void>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ChainStateData>(emptyState());
      return {
        get: Ref.get(ref),
        getBalance: (addr) => Effect.map(Ref.get(ref), (s) => s.balances.get(addr) ?? 0),
        getMarket: (id) => Effect.map(Ref.get(ref), (s) => s.markets.get(id)),
        getMarkets: Effect.map(Ref.get(ref), (s) =>
          Array.from(s.markets.values()).map((m) => ({ market: m, pool: s.pools.get(m.id)! })),
        ),
        getPool: (id) => Effect.map(Ref.get(ref), (s) => s.pools.get(id)),
        getPositions: (owner) =>
          Effect.map(Ref.get(ref), (s) =>
            Array.from(s.positions.values()).filter((p) => p.owner === owner),
          ),
        applyBlock: (block) => Ref.update(ref, (state) => applyBlockPure(state, block)),
      };
    }),
  );
}
