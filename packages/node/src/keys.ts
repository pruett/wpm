import { Context, Effect, Layer } from "effect";
import { readFileSync } from "node:fs";

export class Keys extends Context.Tag("Keys")<
  Keys,
  {
    readonly poaPublicKey: string;
    readonly poaPrivateKey: string;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.try({
      try: () => ({
        poaPublicKey: readFileSync("./data/keys/node.pub", "utf-8").trim(),
        poaPrivateKey: readFileSync("./data/keys/node.pem", "utf-8").trim(),
      }),
      catch: (e) => new Error(`Failed to load keys: ${e}`),
    }),
  );
}
