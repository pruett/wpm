import { getMarket } from "@/data/markets";
import { getPositions } from "@/data/positions";
import { BetControls } from "@/components/bet-controls";
import type { SharePosition } from "@wpm/shared";

export async function MarketDetail({ id, userId }: { id: string; userId?: string }) {
  const [market, positions] = await Promise.all([
    getMarket(id),
    userId ? getPositions(userId) : ([] as SharePosition[]),
  ]);
  const marketPositions = positions.filter((p) => p.marketId === id);

  return <BetControls market={market} userId={userId} positions={marketPositions} />;
}
