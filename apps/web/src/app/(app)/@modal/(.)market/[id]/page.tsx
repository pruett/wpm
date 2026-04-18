import { Suspense } from "react";
import { getSession } from "@/data/auth";
import { MarketDrawer } from "@/components/market-drawer";
import { MarketDetail } from "@/components/market-detail";

export default function MarketModal({ params }: { params: Promise<{ id: string }> }) {
  return (
    <MarketDrawer>
      <Suspense
        fallback={<p className="font-mono text-sm text-muted-foreground">Loading market…</p>}
      >
        <MarketModalContent params={params} />
      </Suspense>
    </MarketDrawer>
  );
}

async function MarketModalContent({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  return <MarketDetail id={id} userId={session?.user.id} />;
}
