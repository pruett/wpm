import { sha256, sign } from "@wpm/shared";
import type { Block, Transaction } from "@wpm/shared";
import { validateTransaction } from "./validation.js";
import type { ChainState } from "./state.js";
import type { Mempool } from "./mempool.js";
import { appendBlock } from "./persistence.js";

const POLL_INTERVAL_MS = 1_000;
const MAX_TXS_PER_BLOCK = 100;

export function startProducer(
  state: ChainState,
  mempool: Mempool,
  poaPrivateKey: string,
  chainFilePath?: string,
  oraclePublicKey?: string,
): { stop: () => void } {
  const timer = setInterval(() => {
    produceBlock(state, mempool, poaPrivateKey, chainFilePath, oraclePublicKey);
  }, POLL_INTERVAL_MS);

  return {
    stop: () => clearInterval(timer),
  };
}

export function produceBlock(
  state: ChainState,
  mempool: Mempool,
  poaPrivateKey: string,
  chainFilePath?: string,
  oraclePublicKey?: string,
): Block | null {
  if (mempool.size === 0) return null;

  const candidates = mempool.drain(MAX_TXS_PER_BLOCK);

  const validTxs: Transaction[] = [];
  for (const tx of candidates) {
    const result = validateTransaction(tx, state, oraclePublicKey);
    if (result.valid) {
      validTxs.push(tx);
    }
  }

  if (validTxs.length === 0) return null;

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

  appendBlock(block, chainFilePath);
  state.applyBlock(block);

  return block;
}
