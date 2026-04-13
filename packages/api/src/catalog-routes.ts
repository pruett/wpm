import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { Effect, Schema } from "effect";
import { calculateOdds, MARKET_CATEGORIES } from "@wpm/shared";
import type {
  AMMPool,
  Market,
  MarketWithOdds,
  MarketBettor,
  CategoryInfo,
  MarketsResponse,
  SharePosition,
} from "@wpm/shared";
import { NodeClient } from "./node-client.js";
import { WalletKeystore } from "./wallet-keystore.js";

const IdParams = Schema.Struct({ id: Schema.String });
const SlugParams = Schema.Struct({ slug: Schema.String });

function enrichMarkets(
  raw: Array<{ market: Market; pool: AMMPool }>,
  positionsByMarket: Map<string, SharePosition[]>,
): MarketWithOdds[] {
  return raw.map(({ market, pool }) => {
    const positions = positionsByMarket.get(market.id) ?? [];
    const bettorCount = new Set(positions.map((p) => p.owner)).size;
    if (market.status === "resolved") {
      const winA = market.result === "A" ? 1.0 : 0.0;
      const winB = market.result === "B" ? 1.0 : 0.0;
      return {
        ...market,
        priceA: winA,
        priceB: winB,
        multiplierA: winA > 0 ? 1 / winA : 0,
        multiplierB: winB > 0 ? 1 / winB : 0,
        pool,
        bettorCount,
      };
    }
    const odds = calculateOdds(pool);
    return { ...market, ...odds, pool, bettorCount };
  });
}

export const makeCatalogRoutes = Effect.gen(function* () {
  const nodeClient = yield* NodeClient;
  const keystore = yield* WalletKeystore;

  function groupPositionsByMarket(positions: SharePosition[]): Map<string, SharePosition[]> {
    const map = new Map<string, SharePosition[]>();
    for (const p of positions) {
      const list = map.get(p.marketId);
      if (list) list.push(p);
      else map.set(p.marketId, [p]);
    }
    return map;
  }

  function resolveBettors(positions: SharePosition[]): MarketBettor[] {
    return positions.map((p) => {
      const wallet = keystore.getByAddress(p.owner);
      return {
        name: wallet?.userId ?? p.owner.slice(0, 8),
        address: p.owner,
        outcome: p.outcome,
        shares: p.shares,
        costBasis: p.costBasis,
      };
    });
  }

  return HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/markets",
      Effect.gen(function* () {
        const [raw, allPositions] = yield* Effect.all([
          nodeClient.getMarkets,
          nodeClient.getAllPositions,
        ]);
        const positionsByMarket = groupPositionsByMarket(allPositions);
        const markets = enrichMarkets(raw, positionsByMarket);
        const active = markets
          .filter((m) => m.status === "open" && m.pool.sharesA !== m.pool.sharesB)
          .map((m) => m.id);
        const response: MarketsResponse = { active, markets };
        return yield* HttpServerResponse.json(response);
      }),
    ),

    HttpRouter.get(
      "/api/markets/:id",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams);
        const raw = yield* nodeClient.getMarket(id);
        if (!raw) {
          return yield* HttpServerResponse.json({ error: "Market not found" }, { status: 404 });
        }
        const positions = yield* nodeClient.getPositionsByMarket(id);
        const positionsByMarket = new Map([[id, positions]]);
        const [enriched] = enrichMarkets([raw], positionsByMarket);
        return yield* HttpServerResponse.json(enriched);
      }).pipe(
        Effect.catchTag("NodeClientError", (e) =>
          HttpServerResponse.json({ error: e.message }, { status: 502 }),
        ),
      ),
    ),

    HttpRouter.get(
      "/api/markets/:id/bettors",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams);
        const positions = yield* nodeClient.getPositionsByMarket(id);
        const bettors = resolveBettors(positions);
        return yield* HttpServerResponse.json(bettors);
      }).pipe(
        Effect.catchTag("NodeClientError", (e) =>
          HttpServerResponse.json({ error: e.message }, { status: 502 }),
        ),
      ),
    ),

    HttpRouter.get(
      "/api/categories",
      Effect.gen(function* () {
        const raw = yield* nodeClient.getMarkets;
        const categories: CategoryInfo[] = MARKET_CATEGORIES.map((cat) => {
          const count = raw.filter(({ market }) => market.id.startsWith(cat.prefix)).length;
          return {
            slug: cat.slug,
            name: cat.name,
            sport: cat.sport,
            logo: cat.logo,
            marketCount: count,
          };
        });
        return yield* HttpServerResponse.json(categories);
      }).pipe(
        Effect.catchTag("NodeClientError", (e) =>
          HttpServerResponse.json({ error: e.message }, { status: 502 }),
        ),
      ),
    ),

    HttpRouter.get(
      "/api/categories/:slug/markets",
      Effect.gen(function* () {
        const { slug } = yield* HttpRouter.schemaPathParams(SlugParams);
        const category = MARKET_CATEGORIES.find((c) => c.slug === slug);
        if (!category) {
          return yield* HttpServerResponse.json({ error: "Unknown category" }, { status: 404 });
        }
        const [raw, allPositions] = yield* Effect.all([
          nodeClient.getMarkets,
          nodeClient.getAllPositions,
        ]);
        const filtered = raw.filter(({ market }) => market.id.startsWith(category.prefix));
        const positionsByMarket = groupPositionsByMarket(allPositions);
        const markets = enrichMarkets(filtered, positionsByMarket);
        return yield* HttpServerResponse.json(markets);
      }).pipe(
        Effect.catchTag("NodeClientError", (e) =>
          HttpServerResponse.json({ error: e.message }, { status: 502 }),
        ),
      ),
    ),
  );
});
