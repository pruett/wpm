import type { Transaction } from "@wpm/shared";
import { validateTransaction } from "./validation.js";
import type { ChainState } from "./state.js";

type MempoolError = {
  code: string;
  message: string;
};

type MempoolResult =
  | { accepted: true }
  | { accepted: false; error: MempoolError };

const MAX_TIMESTAMP_DRIFT_MS = 300_000;

export class Mempool {
  private readonly queue: Transaction[] = [];
  private readonly pendingIds: Set<string> = new Set();
  private readonly oraclePublicKey?: string;

  constructor(oraclePublicKey?: string) {
    this.oraclePublicKey = oraclePublicKey;
  }

  add(tx: Transaction, state: ChainState): MempoolResult {
    const drift = Math.abs(tx.timestamp - Date.now());
    if (drift > MAX_TIMESTAMP_DRIFT_MS) {
      return {
        accepted: false,
        error: {
          code: "TIMESTAMP_OUT_OF_RANGE",
          message: `Transaction timestamp is ${drift}ms from wall-clock time (max ${MAX_TIMESTAMP_DRIFT_MS}ms)`,
        },
      };
    }

    if (this.pendingIds.has(tx.id)) {
      return {
        accepted: false,
        error: {
          code: "DUPLICATE_TX",
          message: `Transaction ${tx.id} is already in the mempool`,
        },
      };
    }

    const validation = validateTransaction(tx, state, this.oraclePublicKey);
    if (!validation.valid) {
      return { accepted: false, error: validation.error };
    }

    this.queue.push(tx);
    this.pendingIds.add(tx.id);
    return { accepted: true };
  }

  drain(max: number): Transaction[] {
    const taken = this.queue.splice(0, max);
    for (const tx of taken) {
      this.pendingIds.delete(tx.id);
    }
    return taken;
  }

  get size(): number {
    return this.queue.length;
  }
}
