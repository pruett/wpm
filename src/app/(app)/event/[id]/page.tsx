import Link from "next/link";
import { Suspense } from "react";

import { EventDetail } from "@/components/event-detail";
import { getSession } from "@/data/auth";

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
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
        fallback={<p className="font-mono text-sm text-muted-foreground">Loading event…</p>}
      >
        <EventPageContent params={params} />
      </Suspense>
    </main>
  );
}

async function EventPageContent({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, getSession()]);
  return <EventDetail id={id} userId={session?.user.id} />;
}
