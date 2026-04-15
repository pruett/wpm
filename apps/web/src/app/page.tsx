import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { provisionWalletIfNeeded } from "@/lib/wallet/provisionWalletIfNeeded";
import { Dashboard } from "./dashboard";
import { RealtimeProvider } from "@/lib/realtime/RealtimeProvider";
import { Landing } from "./landing";
import { Header } from "@/components/header";
import { ScrollingLeaderboard } from "@/components/scrolling-leaderboard";
import { Portfolio } from "@/components/portfolio";

export default async function Home() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return <Landing />;
  }

  await provisionWalletIfNeeded({
    id: session.user.id,
    walletPublicKey: session.user.walletPublicKey,
  });

  return (
    <RealtimeProvider>
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
    </RealtimeProvider>
  );
}
