import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { sha256, verify } from "@wpm/shared";
import type { Block } from "@wpm/shared";
import { ChainState } from "./state.js";

const DEFAULT_CHAIN_FILE = "/data/chain.jsonl";

export function getChainFilePath(): string {
  return process.env.CHAIN_FILE ?? DEFAULT_CHAIN_FILE;
}

export function appendBlock(block: Block, filePath?: string): void {
  const path = filePath ?? getChainFilePath();
  appendFileSync(path, JSON.stringify(block) + "\n");
}

export function replayChain(
  poaPublicKey: string,
  filePath?: string,
): ChainState {
  const path = filePath ?? getChainFilePath();

  if (!existsSync(path)) {
    return new ChainState(poaPublicKey);
  }

  const content = readFileSync(path, "utf-8").trimEnd();
  if (content.length === 0) {
    return new ChainState(poaPublicKey);
  }

  const state = new ChainState(poaPublicKey);
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    let block: Block;
    try {
      block = JSON.parse(lines[i]) as Block;
    } catch {
      throw new Error(`Invalid JSON at block index ${i}`);
    }

    validateBlockIntegrity(block, i, state);
    state.applyBlock(block);
  }

  return state;
}

function validateBlockIntegrity(
  block: Block,
  expectedIndex: number,
  state: ChainState,
): void {
  if (block.index !== expectedIndex) {
    throw new Error(
      `Block index mismatch at position ${expectedIndex}: expected ${expectedIndex}, got ${block.index}`,
    );
  }

  const expectedPreviousHash =
    expectedIndex === 0
      ? "0"
      : state.chain[expectedIndex - 1].hash;

  if (block.previousHash !== expectedPreviousHash) {
    throw new Error(
      `Invalid previousHash at block ${expectedIndex}: expected ${expectedPreviousHash}, got ${block.previousHash}`,
    );
  }

  const hashData = JSON.stringify({
    ...block,
    hash: undefined,
    signature: undefined,
  });
  const computedHash = sha256(hashData);
  if (block.hash !== computedHash) {
    throw new Error(
      `Invalid hash at block ${expectedIndex}: expected ${computedHash}, got ${block.hash}`,
    );
  }

  if (!verify(block.hash, block.signature, state.treasuryAddress)) {
    throw new Error(`Invalid signature at block ${expectedIndex}`);
  }
}
