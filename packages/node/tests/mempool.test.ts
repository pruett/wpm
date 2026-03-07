import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { generateKeyPair, sign } from "@wpm/shared";
import type { TransferTx } from "@wpm/shared";
import { createGenesisBlock } from "../src/genesis.js";
import { ChainState } from "../src/state.js";
import { Mempool } from "../src/mempool.js";

function buildTransferTx(
  sender: string,
  recipient: string,
  amount: number,
  privateKey: string,
): TransferTx {
  const tx: TransferTx = {
    id: randomUUID(),
    type: "Transfer",
    timestamp: Date.now(),
    sender,
    recipient,
    amount,
    signature: "",
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, privateKey);
  return tx;
}

describe("Mempool hardening (FR-14)", () => {
  let poaPublicKey: string;
  let poaPrivateKey: string;
  let userPublicKey: string;
  let userPrivateKey: string;
  let state: ChainState;

  beforeAll(() => {
    const poaKeys = generateKeyPair();
    poaPublicKey = poaKeys.publicKey;
    poaPrivateKey = poaKeys.privateKey;

    const userKeys = generateKeyPair();
    userPublicKey = userKeys.publicKey;
    userPrivateKey = userKeys.privateKey;

    // Set up state with genesis + fund user
    const genesis = createGenesisBlock(poaPublicKey, poaPrivateKey);
    state = new ChainState(poaPublicKey);
    state.applyBlock(genesis);

    // Give user a large balance for capacity testing
    state.credit(userPublicKey, 1_000_000);
  });

  it("rejects with MEMPOOL_FULL when capacity reached (add)", () => {
    const mempool = new Mempool();

    // Fill mempool to capacity with 1000 txs
    for (let i = 0; i < 1000; i++) {
      const tx = buildTransferTx(userPublicKey, poaPublicKey, 0.01, userPrivateKey);
      const result = mempool.add(tx, state);
      expect(result.accepted).toBe(true);
    }

    expect(mempool.size).toBe(1000);

    // The 1001st should be rejected
    const overflowTx = buildTransferTx(userPublicKey, poaPublicKey, 0.01, userPrivateKey);
    const result = mempool.add(overflowTx, state);
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.code).toBe("MEMPOOL_FULL");
    }
  });

  it("rejects with MEMPOOL_FULL when capacity reached (addDirect)", () => {
    const mempool = new Mempool();

    // Fill mempool to capacity
    for (let i = 0; i < 1000; i++) {
      const tx = buildTransferTx(userPublicKey, poaPublicKey, 0.01, userPrivateKey);
      const result = mempool.addDirect(tx);
      expect(result.accepted).toBe(true);
    }

    const overflowTx = buildTransferTx(userPublicKey, poaPublicKey, 0.01, userPrivateKey);
    const result = mempool.addDirect(overflowTx);
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.code).toBe("MEMPOOL_FULL");
    }
  });

  it("accepts again after draining frees capacity", () => {
    const mempool = new Mempool();

    // Fill to capacity
    for (let i = 0; i < 1000; i++) {
      const tx = buildTransferTx(userPublicKey, poaPublicKey, 0.01, userPrivateKey);
      mempool.add(tx, state);
    }

    // Drain some
    mempool.drain(10);
    expect(mempool.size).toBe(990);

    // Should accept again
    const tx = buildTransferTx(userPublicKey, poaPublicKey, 0.01, userPrivateKey);
    const result = mempool.add(tx, state);
    expect(result.accepted).toBe(true);
  });

  it("rejects TIMESTAMP_OUT_OF_RANGE for future timestamps", () => {
    const mempool = new Mempool();
    const tx = buildTransferTx(userPublicKey, poaPublicKey, 1, userPrivateKey);
    tx.timestamp = Date.now() + 400_000; // 400s in future, exceeds 300s window
    // Re-sign with updated timestamp
    tx.signature = sign(JSON.stringify({ ...tx, signature: undefined }), userPrivateKey);

    const result = mempool.add(tx, state);
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.code).toBe("TIMESTAMP_OUT_OF_RANGE");
    }
  });

  it("rejects TIMESTAMP_OUT_OF_RANGE for past timestamps", () => {
    const mempool = new Mempool();
    const tx = buildTransferTx(userPublicKey, poaPublicKey, 1, userPrivateKey);
    tx.timestamp = Date.now() - 400_000; // 400s in past
    tx.signature = sign(JSON.stringify({ ...tx, signature: undefined }), userPrivateKey);

    const result = mempool.add(tx, state);
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.code).toBe("TIMESTAMP_OUT_OF_RANGE");
    }
  });

  it("rejects duplicate against committedTxIds", () => {
    const mempool = new Mempool();
    const tx = buildTransferTx(userPublicKey, poaPublicKey, 1, userPrivateKey);

    // Simulate the tx already being committed on-chain
    state.committedTxIds.add(tx.id);

    const result = mempool.add(tx, state);
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.code).toBe("DUPLICATE_TX");
    }

    // Clean up
    state.committedTxIds.delete(tx.id);
  });

  it("rejects duplicate against pending mempool txs", () => {
    const mempool = new Mempool();
    const tx = buildTransferTx(userPublicKey, poaPublicKey, 1, userPrivateKey);

    const first = mempool.add(tx, state);
    expect(first.accepted).toBe(true);

    const second = mempool.add(tx, state);
    expect(second.accepted).toBe(false);
    if (!second.accepted) {
      expect(second.error.code).toBe("DUPLICATE_TX");
    }
  });
});
