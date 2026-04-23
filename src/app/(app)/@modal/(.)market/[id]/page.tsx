import { Suspense } from "react";

import { MarketDetail } from "@/components/market-detail";
import { MarketDrawer } from "@/components/market-drawer";
import { getSession } from "@/data/auth";

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
