import { Suspense } from "react";

import { Header } from "@/components/header";
import { Portfolio } from "@/components/portfolio";
import { ScrollingLeaderboard } from "@/components/scrolling-leaderboard";
import { getSession } from "@/data/auth";

import { Dashboard } from "./dashboard";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}

async function HomeContent() {
  const session = await getSession();
  if (!session) return null;

  return (
    <>
      <Header user={{ id: session.user.id, name: session.user.name }} />
      <Suspense>
        <ScrollingLeaderboard />
      </Suspense>
      <main className="mx-auto max-w-screen-xl px-4 py-6">
        <Suspense fallback={<p>Loading markets…</p>}>
          <Dashboard />
        </Suspense>
        <Suspense>
          <Portfolio userId={session.user.id} />
        </Suspense>
      </main>
    </>
  );
}
