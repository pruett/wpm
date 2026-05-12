import { Suspense } from "react";

import { EventDetail } from "@/components/event-detail";
import { MarketDrawer } from "@/components/market-drawer";
import { getSession } from "@/data/auth";

export default function EventModal({ params }: { params: Promise<{ id: string }> }) {
  return (
    <MarketDrawer>
      <Suspense
        fallback={<p className="font-mono text-sm text-muted-foreground">Loading event…</p>}
      >
        <EventModalContent params={params} />
      </Suspense>
    </MarketDrawer>
  );
}

async function EventModalContent({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  return <EventDetail id={id} userId={session?.user.id} />;
}
