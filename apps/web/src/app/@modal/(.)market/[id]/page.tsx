import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
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
  const [{ id }, session] = await Promise.all([
    params,
    auth.api.getSession({ headers: await headers() }),
  ]);
  return <MarketDetail id={id} userId={session?.user.id} />;
}
