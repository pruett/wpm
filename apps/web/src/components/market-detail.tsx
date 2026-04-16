import { connection } from "next/server";
import { getMarket } from "@/lib/data/market";
import { getPositions } from "@/lib/data/positions";
import { BetControls } from "@/components/bet-controls";
import type { SharePosition } from "@wpm/shared";

export async function MarketDetail({ id, userId }: { id: string; userId?: string }) {
  await connection();
  const [market, positions] = await Promise.all([
    getMarket(id),
    userId ? getPositions(userId) : ([] as SharePosition[]),
  ]);
  const marketPositions = positions.filter((p) => p.marketId === id);

  return <BetControls market={market} userId={userId} positions={marketPositions} />;
}
