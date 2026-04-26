import { Search } from "@/components/search";
import { getMarkets } from "@/data/markets";

export async function Dashboard() {
  const { markets } = await getMarkets();
  const openMarkets = markets
    .filter((m) => m.status === "open")
    .sort((a, b) => b.bettorCount - a.bettorCount);

  return (
    <section>
      <h2 className="mb-4 font-mono text-lg font-bold tracking-wider uppercase">Markets</h2>
      <Search markets={openMarkets} />
    </section>
  );
}
