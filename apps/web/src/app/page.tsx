import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { provisionWalletIfNeeded } from "@/lib/wallet/provisionWalletIfNeeded";
import { Dashboard } from "./dashboard";
import { RealtimeProvider } from "@/lib/realtime/RealtimeProvider";
import { LiveTicker } from "./live-ticker";
import { Landing } from "./landing";

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
      <main>
        <h1>WPM</h1>
        <Suspense fallback={<p>Loading markets…</p>}>
          <Dashboard />
        </Suspense>
        <LiveTicker />
      </main>
    </RealtimeProvider>
  );
}
