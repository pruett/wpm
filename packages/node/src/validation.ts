import { sha256, verify } from "@wpm/shared";
import type { Block, Transaction, TransferTx } from "@wpm/shared";
import type { ChainState } from "./state.js";

type ValidationError = {
  code: string;
  message: string;
};

type ValidationResult =
  | { valid: true }
  | { valid: false; error: ValidationError };

function fail(code: string, message: string): ValidationResult {
  return { valid: false, error: { code, message } };
}

const OK: ValidationResult = { valid: true };

// --- Block Validation (FR-4) ---

export function validateBlock(
  block: Block,
  state: ChainState,
): ValidationResult {
  const expectedIndex = state.chain.length;

  if (block.index !== expectedIndex) {
    return fail(
      "INVALID_INDEX",
      `Expected index ${expectedIndex}, got ${block.index}`,
    );
  }

  const expectedPreviousHash =
    expectedIndex === 0 ? "0" : state.chain[expectedIndex - 1].hash;

  if (block.previousHash !== expectedPreviousHash) {
    return fail(
      "INVALID_PREVIOUS_HASH",
      `Expected previousHash ${expectedPreviousHash}, got ${block.previousHash}`,
    );
  }

  const hashData = JSON.stringify({
    ...block,
    hash: undefined,
    signature: undefined,
  });
  const computedHash = sha256(hashData);
  if (block.hash !== computedHash) {
    return fail(
      "INVALID_HASH",
      `Computed hash ${computedHash} does not match block hash ${block.hash}`,
    );
  }

  if (!verify(block.hash, block.signature, state.treasuryAddress)) {
    return fail("INVALID_SIGNATURE", "Block signature verification failed");
  }

  return OK;
}

// --- Transaction Validation (FR-5+) ---

export function validateTransaction(
  tx: Transaction,
  state: ChainState,
): ValidationResult {
  if (state.committedTxIds.has(tx.id)) {
    return fail("DUPLICATE_TX", `Transaction ${tx.id} already committed`);
  }

  switch (tx.type) {
    case "Transfer":
      return validateTransfer(tx, state);
    default:
      return fail(
        "UNSUPPORTED_TX_TYPE",
        `Validation for ${tx.type} not yet implemented`,
      );
  }
}

// --- Transfer Validation (FR-5) ---

function hasTwoDecimalPlaces(amount: number): boolean {
  return Math.round(amount * 100) === amount * 100;
}

function validateTransfer(
  tx: TransferTx,
  state: ChainState,
): ValidationResult {
  if (tx.amount <= 0) {
    return fail("INVALID_AMOUNT", "Transfer amount must be greater than 0");
  }

  if (!hasTwoDecimalPlaces(tx.amount)) {
    return fail("INVALID_PRECISION", "Amount must have at most 2 decimal places");
  }

  if (tx.sender === tx.recipient) {
    return fail("SELF_TRANSFER", "Sender and recipient must be different");
  }

  if (state.getBalance(tx.sender) < tx.amount) {
    return fail(
      "INSUFFICIENT_BALANCE",
      `Sender balance ${state.getBalance(tx.sender)} is less than amount ${tx.amount}`,
    );
  }

  const signData = JSON.stringify({ ...tx, signature: undefined });
  if (!verify(signData, tx.signature, tx.sender)) {
    return fail("INVALID_SIGNATURE", "Transaction signature verification failed");
  }

  return OK;
}
