import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { provisionWalletIfNeeded } from "@/lib/wallet/provisionWalletIfNeeded";
import { Dashboard } from "./dashboard";
import { RealtimeProvider } from "@/lib/realtime/RealtimeProvider";
import { LiveTicker } from "./live-ticker";
import { Landing } from "./landing";
import { Header } from "@/components/header";

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
      <main className="mx-auto max-w-screen-xl px-4 py-6">
        <Suspense fallback={<p>Loading markets…</p>}>
          <Dashboard />
        </Suspense>
        <LiveTicker />
      </main>
    </RealtimeProvider>
  );
}
