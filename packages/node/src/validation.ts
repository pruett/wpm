import { Effect } from "effect";
import type { Transaction } from "@wpm/shared";
import { verify, serializeTx, addressOf } from "@wpm/shared";
import type { ChainStateData } from "./chain-state.js";
import { ValidationError } from "./errors.js";

function requireSignature(tx: { signature: string; submitter: string }) {
  const data = serializeTx(tx as Record<string, unknown>);
  if (!verify(data, tx.signature, tx.submitter)) {
    return Effect.fail(
      new ValidationError({ code: "INVALID_SIGNATURE", message: "Signature verification failed" }),
    );
  }
  return Effect.void;
}

function requireOpenMarket(marketId: string, state: ChainStateData) {
  const market = state.markets.get(marketId);
  if (!market) {
    return Effect.fail(
      new ValidationError({ code: "MARKET_NOT_FOUND", message: `Market ${marketId} not found` }),
    );
  }
  if (market.status !== "open") {
    return Effect.fail(
      new ValidationError({ code: "MARKET_CLOSED", message: "Market is not open" }),
    );
  }
  return Effect.succeed(market);
}

export function validateTransaction(
  tx: Transaction,
  state: ChainStateData,
  keys: { poaPublicKey: string; poaPrivateKey: string },
): Effect.Effect<void, ValidationError> {
  return Effect.gen(function* () {
    if (tx.type === "Distribute") return;
    if (tx.type === "SettlePayout") return;

    if (tx.type === "ResolveMarket") {
      const market = state.markets.get(tx.marketId);
      if (!market) {
        return yield* Effect.fail(
          new ValidationError({
            code: "MARKET_NOT_FOUND",
            message: `Market ${tx.marketId} not found`,
          }),
        );
      }
      if (market.status !== "open") {
        return yield* Effect.fail(
          new ValidationError({
            code: "MARKET_NOT_OPEN",
            message: "Market is not open for resolution",
          }),
        );
      }
      return;
    }

    if (tx.type === "CreateMarket") {
      if (state.markets.has(tx.id)) {
        return yield* Effect.fail(
          new ValidationError({
            code: "MARKET_EXISTS",
            message: `Market ${tx.id} already exists`,
          }),
        );
      }
      const treasuryBalance = state.balances.get(addressOf(keys.poaPublicKey)) ?? 0;
      if (treasuryBalance < tx.seedAmount) {
        return yield* Effect.fail(
          new ValidationError({
            code: "INSUFFICIENT_BALANCE",
            message: "Treasury cannot afford seed amount",
          }),
        );
      }
      return;
    }

    if (tx.type === "SellShares") {
      yield* requireSignature(tx);
      yield* requireOpenMarket(tx.marketId, state);
      if (tx.shares <= 0) {
        return yield* Effect.fail(
          new ValidationError({ code: "INVALID_AMOUNT", message: "Shares must be greater than 0" }),
        );
      }
      const posKey = `${addressOf(tx.submitter)}:${tx.marketId}:${tx.outcome}`;
      const position = state.positions.get(posKey);
      if (!position || position.shares < tx.shares) {
        return yield* Effect.fail(
          new ValidationError({
            code: "INSUFFICIENT_SHARES",
            message: "Not enough shares to sell",
          }),
        );
      }
      return;
    }

    if (tx.type === "PlaceBet") {
      yield* requireSignature(tx);
      yield* requireOpenMarket(tx.marketId, state);
      if (tx.amount <= 0) {
        return yield* Effect.fail(
          new ValidationError({ code: "INVALID_AMOUNT", message: "Amount must be greater than 0" }),
        );
      }
      const balance = state.balances.get(addressOf(tx.submitter)) ?? 0;
      if (balance < tx.amount) {
        return yield* Effect.fail(
          new ValidationError({ code: "INSUFFICIENT_BALANCE", message: "Not enough WPM" }),
        );
      }
    }
  });
}
