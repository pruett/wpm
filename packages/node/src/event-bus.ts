import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { Scope } from "effect";
import type { TradeExecutedEvent } from "@wpm/shared";

export class EventBus extends Context.Tag("EventBus")<
  EventBus,
  {
    readonly publish: (event: TradeExecutedEvent) => Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<Stream.Stream<TradeExecutedEvent>, never, Scope.Scope>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<TradeExecutedEvent>();
      return {
        publish: (event) => pubsub.publish(event),
        subscribe: Effect.map(pubsub.subscribe, (queue) => Stream.fromQueue(queue)),
      };
    }),
  );
}
