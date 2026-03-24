import { Context, Effect, Layer, Ref } from "effect";
import type { Block } from "@wpm/shared";
import { PersistenceError } from "./errors.js";
import { readFileSync, appendFileSync, existsSync } from "node:fs";

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
        try: () => appendFileSync("./data/chain.jsonl", JSON.stringify(block) + "\n"),
        catch: (e) => new PersistenceError({ message: `${e}` }),
      }),
    loadChain: Effect.try({
      try: () => {
        if (!existsSync("./data/chain.jsonl")) return [];
        return readFileSync("./data/chain.jsonl", "utf-8")
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
