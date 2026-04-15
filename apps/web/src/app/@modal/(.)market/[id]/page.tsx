import { Suspense } from "react";
import { MarketSheet } from "@/components/market-sheet";
import { MarketDetail } from "@/components/market-detail";

export default function MarketModal({ params }: { params: Promise<{ id: string }> }) {
  return (
    <MarketSheet>
      <Suspense
        fallback={<p className="font-mono text-sm text-muted-foreground">Loading market…</p>}
      >
        <MarketModalContent params={params} />
      </Suspense>
    </MarketSheet>
  );
}

async function MarketModalContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MarketDetail id={id} />;
}
