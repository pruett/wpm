import { getMarkets } from "@/data/markets";
import { Search } from "@/components/search";

export async function Dashboard() {
  const { markets } = await getMarkets();
  const openMarkets = markets.filter((m) => m.status === "open");

  return (
    <section>
      <h2 className="mb-4 font-mono text-lg font-bold uppercase tracking-wider">Markets</h2>
      <Search markets={openMarkets} />
    </section>
  );
}
