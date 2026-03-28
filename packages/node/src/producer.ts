import { Effect } from "effect";
import type { Block, Transaction } from "@wpm/shared";
import { sha256, sign, addressOf } from "@wpm/shared";
import { ChainState } from "./chain-state.js";
import { Mempool } from "./mempool.js";
import { Persistence } from "./persistence.js";
import { Keys } from "./keys.js";
import { EventBus } from "./event-bus.js";

function buildBlock(
  index: number,
  txs: Transaction[],
  previousHash: string,
  keys: { poaPublicKey: string; poaPrivateKey: string },
): Block {
  const block: Block = {
    index,
    timestamp: new Date().toISOString(),
    transactions: txs,
    previousHash,
    hash: "",
    signature: "",
    signer: keys.poaPublicKey,
  };
  block.hash = sha256(JSON.stringify({ ...block, hash: "", signature: "" }));
  block.signature = sign(block.hash, keys.poaPrivateKey);
  return block;
}

export const produceBlock = Effect.gen(function* () {
  const mempool = yield* Mempool;
  const chainState = yield* ChainState;
  const persistence = yield* Persistence;
  const keys = yield* Keys;
  const eventBus = yield* EventBus;

  const txs = yield* mempool.drain(100);
  if (txs.length === 0) return;
  yield* Effect.logInfo(`Producing block with ${txs.length} transaction(s)`);

  const state = yield* chainState.get;
  const prevHash =
    state.chain.length > 0 ? state.chain[state.chain.length - 1].hash : "0".repeat(64);

  const block = buildBlock(state.chain.length, txs, prevHash, keys);

  yield* persistence.appendBlock(block);
  yield* chainState.applyBlock(block);

  // Collect addresses whose balances changed in this block
  const changedAddresses = new Set<string>();

  for (const tx of txs) {
    switch (tx.type) {
      case "Distribute":
        changedAddresses.add(addressOf(tx.to));
        break;
      case "CreateMarket":
        changedAddresses.add(addressOf(block.signer));
        break;
      case "PlaceBet":
        changedAddresses.add(addressOf(tx.submitter));
        break;
      case "SellShares":
        changedAddresses.add(addressOf(tx.submitter));
        break;
      case "SettlePayout":
        changedAddresses.add(tx.to);
        break;
    }

    if (tx.type === "PlaceBet" || tx.type === "SellShares") {
      const pool = yield* chainState.getPool(tx.marketId);
      if (pool) yield* eventBus.publish({ type: "trade:executed", marketId: tx.marketId, pool });
    }
    if (tx.type === "ResolveMarket") {
      yield* eventBus.publish({
        type: "market:resolved",
        marketId: tx.marketId,
        result: tx.result,
      });
    }
  }

  // Emit balance:update for each affected address (once per block, with final balance)
  for (const address of changedAddresses) {
    const balance = yield* chainState.getBalance(address);
    yield* eventBus.publish({ type: "balance:update", address, balance });
  }
});
