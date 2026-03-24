import { Context, Effect, Layer } from "effect";
import { generateKeyPair } from "@wpm/shared";

export class UserKeys extends Context.Tag("UserKeys")<
  UserKeys,
  {
    readonly publicKey: string;
    readonly privateKey: string;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.sync(() => generateKeyPair()),
  );
}
