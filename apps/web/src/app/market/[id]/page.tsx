import { Suspense } from "react";
import Link from "next/link";
import { MarketDetail } from "@/components/market-detail";

export default function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto max-w-screen-xl px-4 py-6">
      <div className="mb-6">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
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
  const { id } = await params;
  return <MarketDetail id={id} />;
}
