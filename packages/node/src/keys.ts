import { Context, Effect, Layer } from "effect";
import { readFileSync } from "node:fs";

const KEYS_DIR = process.env.KEYS_DIR || "./data/keys";

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
        poaPublicKey: readFileSync(`${KEYS_DIR}/node.pub`, "utf-8").trim(),
        poaPrivateKey: readFileSync(`${KEYS_DIR}/node.pem`, "utf-8").trim(),
      }),
      catch: (e) => new Error(`Failed to load keys: ${e}`),
    }),
  );
}
