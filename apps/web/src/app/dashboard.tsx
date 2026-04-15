import { connection } from "next/server";
import { getMarkets } from "@/lib/data/markets";
import { Search } from "@/components/search";

export async function Dashboard() {
  await connection();
  const { markets } = await getMarkets();

  return (
    <section>
      <h2 className="mb-4 font-mono text-lg font-bold uppercase tracking-wider">Markets</h2>
      <Search markets={markets} />
    </section>
  );
}
