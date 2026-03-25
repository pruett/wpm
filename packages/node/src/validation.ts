import { Effect } from "effect";
import type { Transaction } from "@wpm/shared";
import { verify, serializeTx, addressOf } from "@wpm/shared";
import type { ChainStateData } from "./chain-state.js";
import { ValidationError } from "./errors.js";

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

    if (tx.type === "PlaceBet") {
      const data = serializeTx(tx as Record<string, unknown>);
      if (!verify(data, tx.signature, tx.submitter)) {
        return yield* Effect.fail(
          new ValidationError({
            code: "INVALID_SIGNATURE",
            message: "Signature verification failed",
          }),
        );
      }
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
            code: "MARKET_CLOSED",
            message: "Market is not open",
          }),
        );
      }
      const balance = state.balances.get(addressOf(tx.submitter)) ?? 0;
      if (balance < tx.amount) {
        return yield* Effect.fail(
          new ValidationError({
            code: "INSUFFICIENT_BALANCE",
            message: "Not enough WPM",
          }),
        );
      }
    }
  });
}
