import { randomUUID } from "node:crypto";
import { sha256, sign } from "@wpm/shared";
import type { Block, DistributeTx } from "@wpm/shared";

const GENESIS_SUPPLY = 10_000_000;

export function createGenesisBlock(
  poaPublicKey: string,
  poaPrivateKey: string,
): Block {
  const timestamp = Date.now();
  const treasuryAddress = poaPublicKey;

  const distributeTx: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp,
    sender: treasuryAddress,
    recipient: treasuryAddress,
    amount: GENESIS_SUPPLY,
    reason: "genesis",
    signature: "",
  };

  const txSignData = JSON.stringify({ ...distributeTx, signature: undefined });
  distributeTx.signature = sign(txSignData, poaPrivateKey);

  const block: Block = {
    index: 0,
    timestamp,
    transactions: [distributeTx],
    previousHash: "0",
    hash: "",
    signature: "",
  };

  const hashData = JSON.stringify({ ...block, hash: undefined, signature: undefined });
  block.hash = sha256(hashData);
  block.signature = sign(block.hash, poaPrivateKey);

  return block;
}
