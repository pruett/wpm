import type { SharePosition } from "@/lib/types";

import { BetControls } from "@/components/bet-controls";
import { getMarket } from "@/data/markets";
import { getPositions } from "@/data/positions";

export async function MarketDetail({ id, userId }: { id: string; userId?: string }) {
  const [market, positions] = await Promise.all([
    getMarket(id),
    userId ? getPositions(userId) : ([] as SharePosition[]),
  ]);
  const marketPositions = positions.filter((p) => p.marketId === id);

  return <BetControls market={market} userId={userId} positions={marketPositions} />;
}
