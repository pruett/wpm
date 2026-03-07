import { sha256, sign } from "@wpm/shared";
import type { Block, Transaction } from "@wpm/shared";
import { validateTransaction } from "./validation.js";
import { generateResolvePayouts, generateCancelPayouts } from "./settlement.js";
import type { ChainState } from "./state.js";
import type { Mempool } from "./mempool.js";
import { appendBlock } from "./persistence.js";
import type { EventBus } from "./events.js";
import {
  checkPostBlockInvariants,
  checkPoolKInvariant,
  checkPriceSumInvariant,
  handleViolations,
} from "./invariants.js";
import { logger } from "./logger.js";

const POLL_INTERVAL_MS = 1_000;
const MAX_TXS_PER_BLOCK = 100;

export function startProducer(
  state: ChainState,
  mempool: Mempool,
  poaPublicKey: string,
  poaPrivateKey: string,
  chainFilePath?: string,
  oraclePublicKey?: string,
  eventBus?: EventBus,
): { stop: () => void } {
  const timer = setInterval(() => {
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey, eventBus);
  }, POLL_INTERVAL_MS);

  return {
    stop: () => clearInterval(timer),
  };
}

export function produceBlock(
  state: ChainState,
  mempool: Mempool,
  poaPublicKey: string,
  poaPrivateKey: string,
  chainFilePath?: string,
  oraclePublicKey?: string,
  eventBus?: EventBus,
): Block | null {
  if (mempool.size === 0) return null;

  const candidates = mempool.drain(MAX_TXS_PER_BLOCK);

  const SYSTEM_TX_TYPES = new Set(["SettlePayout", "Referral"]);
  const validTxs: Transaction[] = [];
  for (const tx of candidates) {
    const isSystemTx = SYSTEM_TX_TYPES.has(tx.type);
    const result = isSystemTx ? { valid: true as const } : validateTransaction(tx, state, oraclePublicKey);
    if (result.valid) {
      validTxs.push(tx);
      // Inject settlement payouts after ResolveMarket or CancelMarket
      if (tx.type === "ResolveMarket") {
        const payouts = generateResolvePayouts(tx, state, poaPublicKey, poaPrivateKey);
        validTxs.push(...payouts);
      } else if (tx.type === "CancelMarket") {
        const payouts = generateCancelPayouts(tx, state, poaPublicKey, poaPrivateKey);
        validTxs.push(...payouts);
      }
    }
  }

  if (validTxs.length === 0) return null;

  const startMs = Date.now();
  const previousBlock = state.chain[state.chain.length - 1];
  const block: Block = {
    index: state.chain.length,
    timestamp: Date.now(),
    transactions: validTxs,
    previousHash: previousBlock ? previousBlock.hash : "0",
    hash: "",
    signature: "",
  };

  const hashData = JSON.stringify({
    ...block,
    hash: undefined,
    signature: undefined,
  });
  block.hash = sha256(hashData);
  block.signature = sign(block.hash, poaPrivateKey);

  // Snapshot pool k values before applying block for INV-5
  const previousKValues = new Map<string, number>();
  for (const [marketId, pool] of state.pools) {
    previousKValues.set(marketId, pool.k);
  }

  appendBlock(block, chainFilePath);
  if (eventBus) {
    eventBus.emitBlockEvents(block, state);
  }
  state.applyBlock(block);

  const durationMs = Date.now() - startMs;
  logger.metrics.blocksProduced++;
  logger.metrics.blockHeight = block.index + 1;
  logger.metrics.mempoolSize = mempool.size;
  for (const tx of validTxs) {
    if (tx.type === "PlaceBet" || tx.type === "SellShares") {
      logger.metrics.ammTrades++;
    }
  }
  logger.info("block produced", {
    blockIndex: block.index,
    txCount: validTxs.length,
    durationMs,
    blockHeight: block.index + 1,
    mempoolSize: mempool.size,
  });

  // Post-block invariant checks
  const violations = checkPostBlockInvariants(state);

  // INV-5: k only increases (check pools that still exist after block)
  for (const [marketId, pool] of state.pools) {
    const prevK = previousKValues.get(marketId);
    if (prevK !== undefined) {
      const kViolation = checkPoolKInvariant(prevK, pool.k, marketId);
      if (kViolation) violations.push(kViolation);
    }
  }

  // INV-2: priceA + priceB === 1.00 for every open pool
  for (const [marketId, pool] of state.pools) {
    const priceViolation = checkPriceSumInvariant(marketId, pool.sharesA, pool.sharesB);
    if (priceViolation) violations.push(priceViolation);
  }

  if (violations.length > 0) {
    handleViolations(violations, block.index);
  }

  return block;
}
