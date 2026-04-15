import { connection } from "next/server";
import { getMarkets } from "@/lib/data/markets";

export async function Dashboard() {
  await connection();
  const { markets } = await getMarkets();

  return (
    <section>
      <h2>Markets</h2>
      {markets.length === 0 ? (
        <p>No active markets.</p>
      ) : (
        <ul>
          {markets.map((m) => (
            <li key={m.id}>
              <strong>{m.name}</strong>
              <span>
                {" "}
                — {m.outcomes[0]} ({(m.priceA * 100).toFixed(0)}%) vs {m.outcomes[1]} (
                {(m.priceB * 100).toFixed(0)}%)
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
