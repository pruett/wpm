import { sha256, verify } from "@wpm/shared";
import type { Block, Transaction, TransferTx, DistributeTx, CreateMarketTx, PlaceBetTx, SellSharesTx, ResolveMarketTx, CancelMarketTx, ReferralTx } from "@wpm/shared";
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
  oraclePublicKey?: string,
): ValidationResult {
  if (state.committedTxIds.has(tx.id)) {
    return fail("DUPLICATE_TX", `Transaction ${tx.id} already committed`);
  }

  switch (tx.type) {
    case "Transfer":
      return validateTransfer(tx, state);
    case "Distribute":
      return validateDistribute(tx, state);
    case "CreateMarket":
      return validateCreateMarket(tx, state, oraclePublicKey);
    case "PlaceBet":
      return validatePlaceBet(tx, state);
    case "SellShares":
      return validateSellShares(tx, state);
    case "ResolveMarket":
      return validateResolveMarket(tx, state, oraclePublicKey);
    case "CancelMarket":
      return validateCancelMarket(tx, state, oraclePublicKey);
    case "SettlePayout":
      return fail("SYSTEM_TX_ONLY", "SettlePayout transactions are system-generated and cannot be submitted externally");
    case "Referral":
      return fail("SYSTEM_TX_ONLY", "Referral transactions are system-generated and cannot be submitted externally");
    default: {
      const _exhaustive: never = tx;
      return fail(
        "UNSUPPORTED_TX_TYPE",
        `Validation for ${(_exhaustive as Transaction).type} not yet implemented`,
      );
    }
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

// --- Distribute Validation (FR-6) ---

const VALID_DISTRIBUTE_REASONS = new Set([
  "signup_airdrop",
  "referral_reward",
  "manual",
  "genesis",
]);

function validateDistribute(
  tx: DistributeTx,
  state: ChainState,
): ValidationResult {
  if (tx.sender !== state.treasuryAddress) {
    return fail("UNAUTHORIZED_SENDER", "Distribute sender must be the treasury");
  }

  if (tx.amount <= 0) {
    return fail("INVALID_AMOUNT", "Distribute amount must be greater than 0");
  }

  if (!hasTwoDecimalPlaces(tx.amount)) {
    return fail("INVALID_PRECISION", "Amount must have at most 2 decimal places");
  }

  if (!VALID_DISTRIBUTE_REASONS.has(tx.reason)) {
    return fail("INVALID_REASON", `Invalid distribute reason: ${tx.reason}`);
  }

  if (tx.sender !== tx.recipient && state.getBalance(state.treasuryAddress) < tx.amount) {
    return fail(
      "INSUFFICIENT_TREASURY",
      `Treasury balance ${state.getBalance(state.treasuryAddress)} is less than amount ${tx.amount}`,
    );
  }

  const signData = JSON.stringify({ ...tx, signature: undefined });
  if (!verify(signData, tx.signature, state.treasuryAddress)) {
    return fail("INVALID_SIGNATURE", "Transaction signature verification failed");
  }

  return OK;
}

// --- CreateMarket Validation (FR-7) ---

const REQUIRED_MARKET_FIELDS = [
  "sport",
  "homeTeam",
  "awayTeam",
  "outcomeA",
  "outcomeB",
] as const;

function validateCreateMarket(
  tx: CreateMarketTx,
  state: ChainState,
  oraclePublicKey?: string,
): ValidationResult {
  if (!oraclePublicKey || tx.sender !== oraclePublicKey) {
    return fail("UNAUTHORIZED_ORACLE", "CreateMarket sender must be the oracle");
  }

  if (state.markets.has(tx.marketId)) {
    return fail("DUPLICATE_MARKET", `Market ${tx.marketId} already exists`);
  }

  if (state.externalEventIds.has(tx.externalEventId)) {
    return fail("DUPLICATE_EVENT", `External event ${tx.externalEventId} already used`);
  }

  if (tx.eventStartTime <= tx.timestamp) {
    return fail("EVENT_IN_PAST", "Event start time must be in the future");
  }

  if (tx.seedAmount <= 0) {
    return fail("INVALID_SEED", "Seed amount must be greater than 0");
  }

  if (!hasTwoDecimalPlaces(tx.seedAmount)) {
    return fail("INVALID_PRECISION", "Seed amount must have at most 2 decimal places");
  }

  if (state.getBalance(state.treasuryAddress) < tx.seedAmount) {
    return fail(
      "INSUFFICIENT_TREASURY",
      `Treasury balance ${state.getBalance(state.treasuryAddress)} is less than seed amount ${tx.seedAmount}`,
    );
  }

  for (const field of REQUIRED_MARKET_FIELDS) {
    if (!tx[field] || tx[field].trim() === "") {
      return fail("MISSING_FIELD", `Field ${field} is required`);
    }
  }

  const signData = JSON.stringify({ ...tx, signature: undefined });
  if (!verify(signData, tx.signature, oraclePublicKey)) {
    return fail("INVALID_SIGNATURE", "Transaction signature verification failed");
  }

  return OK;
}

// --- PlaceBet Validation (FR-8) ---

function validatePlaceBet(
  tx: PlaceBetTx,
  state: ChainState,
): ValidationResult {
  const market = state.markets.get(tx.marketId);
  if (!market) {
    return fail("MARKET_NOT_FOUND", `Market ${tx.marketId} not found`);
  }

  if (market.status !== "open") {
    return fail("MARKET_NOT_OPEN", `Market ${tx.marketId} is not open`);
  }

  if (tx.timestamp >= market.eventStartTime) {
    return fail("BETTING_CLOSED", "Betting is closed after event start time");
  }

  if (tx.amount <= 0) {
    return fail("INVALID_AMOUNT", "Bet amount must be greater than 0");
  }

  if (tx.amount < 1) {
    return fail("MINIMUM_BET", "Minimum bet is 1.00 WPM");
  }

  if (!hasTwoDecimalPlaces(tx.amount)) {
    return fail("INVALID_PRECISION", "Amount must have at most 2 decimal places");
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

// --- SellShares Validation (FR-9) ---

function validateSellShares(
  tx: SellSharesTx,
  state: ChainState,
): ValidationResult {
  const market = state.markets.get(tx.marketId);
  if (!market) {
    return fail("MARKET_NOT_FOUND", `Market ${tx.marketId} not found`);
  }

  if (market.status !== "open") {
    return fail("MARKET_NOT_OPEN", `Market ${tx.marketId} is not open`);
  }

  if (tx.timestamp >= market.eventStartTime) {
    return fail("BETTING_CLOSED", "Selling is closed after event start time");
  }

  if (tx.shareAmount <= 0) {
    return fail("INVALID_AMOUNT", "Share amount must be greater than 0");
  }

  if (tx.shareAmount < 0.01) {
    return fail("MINIMUM_SELL", "Minimum sell is 0.01 shares");
  }

  const position = state.getSharePosition(tx.sender, tx.marketId, tx.outcome);
  if (position.shares < tx.shareAmount) {
    return fail(
      "INSUFFICIENT_SHARES",
      `Holds ${position.shares} shares but tried to sell ${tx.shareAmount}`,
    );
  }

  const signData = JSON.stringify({ ...tx, signature: undefined });
  if (!verify(signData, tx.signature, tx.sender)) {
    return fail("INVALID_SIGNATURE", "Transaction signature verification failed");
  }

  return OK;
}

// --- ResolveMarket Validation (FR-10) ---

function validateResolveMarket(
  tx: ResolveMarketTx,
  state: ChainState,
  oraclePublicKey?: string,
): ValidationResult {
  if (!oraclePublicKey || tx.sender !== oraclePublicKey) {
    return fail("UNAUTHORIZED_ORACLE", "ResolveMarket sender must be the oracle");
  }

  const market = state.markets.get(tx.marketId);
  if (!market) {
    return fail("MARKET_NOT_FOUND", `Market ${tx.marketId} not found`);
  }

  if (market.status !== "open") {
    return fail("MARKET_NOT_OPEN", `Market ${tx.marketId} is not open`);
  }

  if (tx.timestamp < market.eventStartTime) {
    return fail("EVENT_NOT_STARTED", "Cannot resolve market before event start time");
  }

  const signData = JSON.stringify({ ...tx, signature: undefined });
  if (!verify(signData, tx.signature, oraclePublicKey)) {
    return fail("INVALID_SIGNATURE", "Transaction signature verification failed");
  }

  return OK;
}

// --- Referral Validation (FR-13) ---

export function validateReferral(
  tx: ReferralTx,
  state: ChainState,
): ValidationResult {
  if (tx.sender !== state.treasuryAddress) {
    return fail("UNAUTHORIZED_SENDER", "Referral sender must be the PoA signer / treasury");
  }

  if (state.getBalance(state.treasuryAddress) < tx.amount) {
    return fail(
      "INSUFFICIENT_TREASURY",
      `Treasury balance ${state.getBalance(state.treasuryAddress)} is less than amount ${tx.amount}`,
    );
  }

  if (state.referredUsers.has(tx.referredUser)) {
    return fail("DUPLICATE_REFERRAL", `User ${tx.referredUser} has already been referred`);
  }

  if (state.committedTxIds.has(tx.id)) {
    return fail("DUPLICATE_TX", `Transaction ${tx.id} already committed`);
  }

  const signData = JSON.stringify({ ...tx, signature: undefined });
  if (!verify(signData, tx.signature, state.treasuryAddress)) {
    return fail("INVALID_SIGNATURE", "Transaction signature verification failed");
  }

  return OK;
}

// --- CancelMarket Validation (FR-11) ---

function validateCancelMarket(
  tx: CancelMarketTx,
  state: ChainState,
  oraclePublicKey?: string,
): ValidationResult {
  const isOracle = oraclePublicKey && tx.sender === oraclePublicKey;
  const isPoa = tx.sender === state.treasuryAddress;
  if (!isOracle && !isPoa) {
    return fail("UNAUTHORIZED_SENDER", "CancelMarket sender must be the oracle or PoA signer");
  }

  const market = state.markets.get(tx.marketId);
  if (!market) {
    return fail("MARKET_NOT_FOUND", `Market ${tx.marketId} not found`);
  }

  if (market.status !== "open") {
    return fail("MARKET_NOT_OPEN", `Market ${tx.marketId} is not open`);
  }

  const signatureKey = isOracle ? oraclePublicKey : state.treasuryAddress;
  const cancelSignData = JSON.stringify({ ...tx, signature: undefined });
  if (!verify(cancelSignData, tx.signature, signatureKey)) {
    return fail("INVALID_SIGNATURE", "Transaction signature verification failed");
  }

  return OK;
}
