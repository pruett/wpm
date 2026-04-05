import { Context, Effect, Layer, Ref } from "effect";
import type { Block } from "@wpm/shared";
import { PersistenceError } from "./errors.js";
import { readFileSync, appendFileSync, existsSync } from "node:fs";

const CHAIN_FILE = process.env.CHAIN_FILE || "./data/chain.jsonl";

export class Persistence extends Context.Tag("Persistence")<
  Persistence,
  {
    readonly appendBlock: (block: Block) => Effect.Effect<void, PersistenceError>;
    readonly loadChain: Effect.Effect<Block[], PersistenceError>;
  }
>() {
  static Live = Layer.succeed(this, {
    appendBlock: (block) =>
      Effect.try({
        try: () => appendFileSync(CHAIN_FILE, JSON.stringify(block) + "\n"),
        catch: (e) => new PersistenceError({ message: `${e}` }),
      }),
    loadChain: Effect.try({
      try: () => {
        if (!existsSync(CHAIN_FILE)) return [];
        return readFileSync(CHAIN_FILE, "utf-8")
          .trimEnd()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      },
      catch: (e) => new PersistenceError({ message: `${e}` }),
    }),
  });

  static Test = Layer.effect(
    this,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Block[]>([]);
      return {
        appendBlock: (block: Block) => Ref.update(ref, (bs) => [...bs, block]),
        loadChain: Ref.get(ref),
      };
    }),
  );
}
