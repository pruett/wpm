import "server-only";
import { publish } from "./bus";

export const emit = {
  priceUpdate: (
    marketId: string,
    odds: { priceA: number; priceB: number; multiplierA: number; multiplierB: number },
  ) => publish({ type: "price:update", marketId, ...odds }),
  balanceUpdate: (userId: string, balance: number) =>
    publish({ type: "balance:update", userId, balance }),
  marketResolved: (marketId: string, result: "A" | "B") =>
    publish({ type: "market:resolved", marketId, result }),
};
