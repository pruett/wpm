import Link from "next/link";
import { Suspense } from "react";

import { MarketDetail } from "@/components/market-detail";
import { getSession } from "@/data/auth";

export default function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto max-w-screen-xl px-4 py-6">
      <div className="mb-6">
        <Link
          href="/"
          className="font-mono text-xs tracking-wider text-muted-foreground uppercase hover:text-foreground"
        >
          &larr; Back
        </Link>
      </div>
      <Suspense
        fallback={<p className="font-mono text-sm text-muted-foreground">Loading market…</p>}
      >
        <MarketPageContent params={params} />
      </Suspense>
    </main>
  );
}

async function MarketPageContent({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  return <MarketDetail id={id} userId={session?.user.id} />;
}
