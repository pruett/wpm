import type { Block, Transaction } from "@wpm/shared";
import { sha256, sign, serializeTx } from "@wpm/shared";

const INITIAL_SUPPLY = 10_000_000;

export function createGenesisBlock(keys: { poaPublicKey: string; poaPrivateKey: string }): Block {
  const tx: Transaction = {
    type: "Distribute",
    to: keys.poaPublicKey,
    amount: INITIAL_SUPPLY,
    memo: "genesis",
    signature: "",
    timestamp: new Date().toISOString(),
  };
  tx.signature = sign(serializeTx(tx as Record<string, unknown>), keys.poaPrivateKey);

  const block: Block = {
    index: 0,
    timestamp: new Date().toISOString(),
    transactions: [tx],
    previousHash: "0".repeat(64),
    hash: "",
    signature: "",
    signer: keys.poaPublicKey,
  };
  block.hash = sha256(JSON.stringify({ ...block, hash: "", signature: "" }));
  block.signature = sign(block.hash, keys.poaPrivateKey);

  return block;
}
