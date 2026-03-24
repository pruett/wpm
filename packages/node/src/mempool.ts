import { Context, Effect, Layer, Ref } from "effect";
import type { Transaction } from "@wpm/shared";
import { ChainState } from "./chain-state.js";
import { Keys } from "./keys.js";
import { ValidationError } from "./errors.js";
import { validateTransaction } from "./validation.js";

export class Mempool extends Context.Tag("Mempool")<
  Mempool,
  {
    readonly add: (tx: Transaction) => Effect.Effect<void, ValidationError>;
    readonly drain: (max: number) => Effect.Effect<Transaction[]>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const chainState = yield* ChainState;
      const keys = yield* Keys;
      const ref = yield* Ref.make<Transaction[]>([]);

      return {
        add: (tx) =>
          Effect.gen(function* () {
            const state = yield* chainState.get;
            yield* validateTransaction(tx, state, keys);
            yield* Ref.update(ref, (q) => [...q, tx]);
          }),
        drain: (max) => Ref.modify(ref, (q) => [q.slice(0, max), q.slice(max)]),
      };
    }),
  );
}
